// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @title ColdChain — trust layer for temperature-sensitive shipments
/// @notice Stores the agreed terms of a shipment (parties, sensor key, temperature range,
///         escrowed payment), accepts sensor-signed temperature readings, records violations
///         immutably and settles the escrow according to rules fixed at creation time.
/// @dev Temperatures are expressed in tenths of a degree Celsius (e.g. 2.0°C == 20).
///      Readings are submitted by anyone (a relay / gateway) but MUST carry a valid
///      EIP-191 signature from the sensor registered for the shipment — the signature,
///      not the transaction sender, is what authenticates the data. Each signature also covers
///      the hash of the corresponding off-chain telemetry record, which is what makes the
///      hybrid on-chain/off-chain split verifiable rather than merely declared.
contract ColdChain {
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;

    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    enum Status {
        CREATED, // created by manufacturer, payment escrowed, waiting for carrier
        IN_TRANSIT, // accepted by carrier, readings are being collected
        COMPROMISED, // at least one temperature violation recorded
        DELIVERED, // confirmed by receiver, escrow settled
        CANCELLED, // cancelled by manufacturer before transit, escrow refunded
        EXPIRED // receiver never confirmed; settled by a party after SETTLEMENT_TIMEOUT
    }

    struct Shipment {
        address manufacturer;
        address carrier;
        address receiver;
        address sensor; // address derived from the sensor's public key
        int32 minTemp; // tenths of °C, inclusive
        int32 maxTemp; // tenths of °C, inclusive
        uint16 penaltyBps; // share of payment withheld from carrier on violation (basis points)
        Status status;
        uint64 createdAt;
        uint64 startedAt;
        uint64 deliveredAt;
        uint64 lastReadingAt; // last accepted sensor timestamp (replay / ordering guard)
        uint32 readingCount; // also the sequence number expected from the next reading
        uint32 violationCount;
        uint256 payment; // escrowed wei
        string product;
    }

    struct Violation {
        int32 temperature;
        uint64 timestamp; // sensor timestamp of the reading
        uint64 recordedAt; // block timestamp when it was recorded on-chain
    }

    /// @notice A sensor device authorised to sign readings (FR-01).
    /// @dev `deviceIdHash` commits to the device's off-chain identity (serial number, model,
    ///      calibration certificate, ...) without putting any of it on-chain.
    struct SensorRecord {
        bytes32 deviceIdHash;
        address registeredBy;
        uint64 registeredAt; // 0 == never registered
        bool active;
    }

    struct TelemetryAnchor {
        bytes32 dataHash; // hash of an off-chain telemetry batch
        uint64 fromTimestamp;
        uint64 toTimestamp;
        address anchoredBy;
        uint64 anchoredAt;
    }

    // ---------------------------------------------------------------------
    // Constants & storage
    // ---------------------------------------------------------------------

    uint16 public constant MAX_BPS = 10_000;
    /// @notice How far ahead of block time a sensor timestamp may be.
    uint64 public constant MAX_CLOCK_DRIFT = 15 minutes;
    /// @notice After this much time in transit either party may settle without the receiver,
    ///         so a missing receiver can never lock the escrow forever.
    uint64 public constant SETTLEMENT_TIMEOUT = 30 days;

    /// @notice May grant and revoke sensor registrars. Set once, at deployment.
    address public immutable admin;
    /// @notice Accounts allowed to register sensors and toggle their `active` flag.
    mapping(address account => bool) public isSensorRegistrar;
    mapping(address sensor => SensorRecord) private _sensors;

    uint256 public shipmentCount;
    mapping(uint256 shipmentId => Shipment) private _shipments;
    mapping(uint256 shipmentId => Violation[]) private _violations;
    mapping(uint256 shipmentId => TelemetryAnchor[]) private _anchors;
    /// @notice Pull-payment balances credited on settlement / cancellation.
    mapping(address account => uint256) public pendingWithdrawals;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event SensorRegistered(address indexed sensor, bytes32 deviceIdHash, address indexed registeredBy);
    event SensorActiveSet(address indexed sensor, bool active, address indexed changedBy);
    event RegistrarSet(address indexed account, bool allowed);
    event ShipmentCreated(
        uint256 indexed shipmentId,
        address indexed manufacturer,
        address indexed carrier,
        address receiver,
        address sensor,
        int32 minTemp,
        int32 maxTemp,
        uint256 payment,
        uint16 penaltyBps,
        string product
    );
    event ShipmentStarted(uint256 indexed shipmentId, address indexed carrier, uint64 timestamp);
    event ReadingSubmitted(
        uint256 indexed shipmentId,
        uint32 sequence,
        int32 temperature,
        uint64 timestamp,
        bytes32 telemetryHash,
        address indexed reporter,
        bool inRange
    );
    event TemperatureViolation(
        uint256 indexed shipmentId, int32 temperature, uint64 timestamp, uint32 violationIndex
    );
    event TelemetryAnchored(
        uint256 indexed shipmentId, bytes32 dataHash, uint64 fromTimestamp, uint64 toTimestamp, address indexed anchoredBy
    );
    event ShipmentDelivered(
        uint256 indexed shipmentId,
        address indexed receiver,
        uint64 timestamp,
        uint256 carrierPayout,
        uint256 manufacturerRefund
    );
    event ShipmentExpired(
        uint256 indexed shipmentId, address indexed settledBy, uint256 carrierPayout, uint256 manufacturerRefund
    );
    event ShipmentCancelled(uint256 indexed shipmentId, uint256 refund);
    event Withdrawal(address indexed account, uint256 amount);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error ShipmentNotFound(uint256 shipmentId);
    error InvalidStatus(uint256 shipmentId, Status current);
    error Unauthorized(address caller);
    error ZeroAddress(string field);
    error SensorNotRegistered(address sensor);
    error SensorInactive(address sensor);
    error SensorAlreadyRegistered(address sensor);
    error EmptyDeviceIdHash();
    error InvalidTemperatureRange(int32 minTemp, int32 maxTemp);
    error InvalidPenalty(uint16 penaltyBps);
    error ZeroPayment();
    error InvalidSignature();
    error EmptyTelemetryHash();
    error SequenceMismatch(uint32 expected, uint32 actual);
    error StaleReading(uint64 timestamp, uint64 lastReadingAt);
    error ReadingBeforeTransit(uint64 timestamp, uint64 startedAt);
    error ReadingFromFuture(uint64 timestamp, uint64 blockTimestamp);
    error InvalidAnchorRange(uint64 fromTimestamp, uint64 toTimestamp);
    error SettlementNotYetAvailable(uint64 availableAt);
    error NothingToWithdraw();
    error TransferFailed();

    // ---------------------------------------------------------------------
    // Modifiers
    // ---------------------------------------------------------------------

    modifier exists(uint256 shipmentId) {
        if (shipmentId == 0 || shipmentId > shipmentCount) revert ShipmentNotFound(shipmentId);
        _;
    }

    modifier onlyAdmin() {
        if (msg.sender != admin) revert Unauthorized(msg.sender);
        _;
    }

    modifier onlyRegistrar() {
        if (!isSensorRegistrar[msg.sender]) revert Unauthorized(msg.sender);
        _;
    }

    // ---------------------------------------------------------------------
    // Deployment
    // ---------------------------------------------------------------------

    /// @dev The deployer becomes the admin and the first sensor registrar.
    constructor() {
        admin = msg.sender;
        isSensorRegistrar[msg.sender] = true;
        emit RegistrarSet(msg.sender, true);
    }

    // ---------------------------------------------------------------------
    // Sensor registry
    // ---------------------------------------------------------------------

    /// @notice Grant or revoke the right to register sensors.
    function setRegistrar(address account, bool allowed) external onlyAdmin {
        if (account == address(0)) revert ZeroAddress("account");
        isSensorRegistrar[account] = allowed;
        emit RegistrarSet(account, allowed);
    }

    /// @notice Register an IoT sensor's signing key so shipments may be assigned to it.
    /// @param sensor Address derived from the device's public key.
    /// @param deviceIdHash Commitment to the device's off-chain identity; must not be zero.
    function registerSensor(address sensor, bytes32 deviceIdHash) external onlyRegistrar {
        if (sensor == address(0)) revert ZeroAddress("sensor");
        if (deviceIdHash == bytes32(0)) revert EmptyDeviceIdHash();
        if (_sensors[sensor].registeredAt != 0) revert SensorAlreadyRegistered(sensor);

        _sensors[sensor] = SensorRecord({
            deviceIdHash: deviceIdHash,
            registeredBy: msg.sender,
            registeredAt: uint64(block.timestamp),
            active: true
        });

        emit SensorRegistered(sensor, deviceIdHash, msg.sender);
    }

    /// @notice Retire a compromised or decommissioned sensor, or bring one back into service.
    /// @dev Deliberately does NOT affect shipments already created with this sensor: their
    ///      readings keep verifying against the key fixed at creation time, so retiring a device
    ///      can never rewrite history or strand a shipment mid-transit. The flag only gates
    ///      `createShipment`.
    function setSensorActive(address sensor, bool active) external onlyRegistrar {
        if (_sensors[sensor].registeredAt == 0) revert SensorNotRegistered(sensor);

        _sensors[sensor].active = active;
        emit SensorActiveSet(sensor, active, msg.sender);
    }

    // ---------------------------------------------------------------------
    // Manufacturer actions
    // ---------------------------------------------------------------------

    /// @notice Create a shipment and escrow its delivery payment (msg.value).
    /// @param product Human-readable product label (e.g. "Vaccine Batch A17").
    /// @param carrier Address of the carrier who must accept the shipment.
    /// @param receiver Address of the party that confirms delivery.
    /// @param sensor Address of the IoT sensor's signing key.
    /// @param minTemp Lower bound in tenths of °C (inclusive).
    /// @param maxTemp Upper bound in tenths of °C (inclusive).
    /// @param penaltyBps Share withheld from the carrier if the shipment is compromised.
    function createShipment(
        string calldata product,
        address carrier,
        address receiver,
        address sensor,
        int32 minTemp,
        int32 maxTemp,
        uint16 penaltyBps
    ) external payable returns (uint256 shipmentId) {
        if (carrier == address(0)) revert ZeroAddress("carrier");
        if (receiver == address(0)) revert ZeroAddress("receiver");
        if (sensor == address(0)) revert ZeroAddress("sensor");
        _requireActiveSensor(sensor);
        if (minTemp >= maxTemp) revert InvalidTemperatureRange(minTemp, maxTemp);
        if (penaltyBps > MAX_BPS) revert InvalidPenalty(penaltyBps);
        if (msg.value == 0) revert ZeroPayment();

        shipmentId = ++shipmentCount;
        Shipment storage s = _shipments[shipmentId];
        s.manufacturer = msg.sender;
        s.carrier = carrier;
        s.receiver = receiver;
        s.sensor = sensor;
        s.minTemp = minTemp;
        s.maxTemp = maxTemp;
        s.penaltyBps = penaltyBps;
        s.status = Status.CREATED;
        s.createdAt = uint64(block.timestamp);
        s.payment = msg.value;
        s.product = product;

        emit ShipmentCreated(
            shipmentId, msg.sender, carrier, receiver, sensor, minTemp, maxTemp, msg.value, penaltyBps, product
        );
    }

    /// @notice Cancel a shipment the carrier has not accepted yet; escrow is credited back.
    function cancelShipment(uint256 shipmentId) external exists(shipmentId) {
        Shipment storage s = _shipments[shipmentId];
        if (msg.sender != s.manufacturer) revert Unauthorized(msg.sender);
        if (s.status != Status.CREATED) revert InvalidStatus(shipmentId, s.status);

        s.status = Status.CANCELLED;
        pendingWithdrawals[s.manufacturer] += s.payment;

        emit ShipmentCancelled(shipmentId, s.payment);
    }

    // ---------------------------------------------------------------------
    // Carrier actions
    // ---------------------------------------------------------------------

    /// @notice Carrier accepts the shipment and its terms; monitoring starts.
    function startTransit(uint256 shipmentId) external exists(shipmentId) {
        Shipment storage s = _shipments[shipmentId];
        if (msg.sender != s.carrier) revert Unauthorized(msg.sender);
        if (s.status != Status.CREATED) revert InvalidStatus(shipmentId, s.status);

        s.status = Status.IN_TRANSIT;
        s.startedAt = uint64(block.timestamp);

        emit ShipmentStarted(shipmentId, msg.sender, s.startedAt);
    }

    // ---------------------------------------------------------------------
    // Sensor / gateway actions
    // ---------------------------------------------------------------------

    /// @notice Submit a sensor-signed temperature reading.
    /// @dev Anyone may relay a reading; authenticity comes from the sensor signature over
    ///      `readingDigest(shipmentId, sequence, temperature, timestamp, telemetryHash)`
    ///      (EIP-191 personal_sign). Readings must arrive gap-free (`sequence == readingCount`)
    ///      with strictly increasing timestamps: a relay cannot skip an inconvenient reading and
    ///      continue with later ones, and no reading can be replayed.
    /// @param telemetryHash Hash of the full off-chain telemetry record this reading summarises.
    ///        It is part of what the sensor signs, so the device vouches not only for the
    ///        temperature but for the exact record kept off-chain. Anyone can later re-hash the
    ///        stored record and compare it with the `ReadingSubmitted` log: if the off-chain store
    ///        was edited, the hashes diverge and the sensor's signature proves which side changed.
    function submitReading(
        uint256 shipmentId,
        uint32 sequence,
        int32 temperature,
        uint64 timestamp,
        bytes32 telemetryHash,
        bytes calldata signature
    ) external exists(shipmentId) {
        Shipment storage s = _shipments[shipmentId];
        if (s.status != Status.IN_TRANSIT && s.status != Status.COMPROMISED) {
            revert InvalidStatus(shipmentId, s.status);
        }
        if (telemetryHash == bytes32(0)) revert EmptyTelemetryHash();
        if (sequence != s.readingCount) revert SequenceMismatch(s.readingCount, sequence);
        if (timestamp < s.startedAt) revert ReadingBeforeTransit(timestamp, s.startedAt);
        if (timestamp <= s.lastReadingAt) revert StaleReading(timestamp, s.lastReadingAt);
        if (timestamp > block.timestamp + MAX_CLOCK_DRIFT) revert ReadingFromFuture(timestamp, uint64(block.timestamp));

        bytes32 digest =
            readingDigest(shipmentId, sequence, temperature, timestamp, telemetryHash).toEthSignedMessageHash();
        (address signer, ECDSA.RecoverError err,) = digest.tryRecover(signature);
        if (err != ECDSA.RecoverError.NoError || signer != s.sensor) revert InvalidSignature();

        s.lastReadingAt = timestamp;
        s.readingCount = sequence + 1;

        bool inRange = temperature >= s.minTemp && temperature <= s.maxTemp;
        emit ReadingSubmitted(shipmentId, sequence, temperature, timestamp, telemetryHash, msg.sender, inRange);

        if (!inRange) _recordViolation(shipmentId, s, temperature, timestamp);
    }

    /// @notice Anchor the hash of an off-chain telemetry batch so it can be verified later.
    /// @dev Callable by the carrier (gateway operator) or the manufacturer.
    function anchorTelemetry(uint256 shipmentId, bytes32 dataHash, uint64 fromTimestamp, uint64 toTimestamp)
        external
        exists(shipmentId)
    {
        Shipment storage s = _shipments[shipmentId];
        if (msg.sender != s.carrier && msg.sender != s.manufacturer) revert Unauthorized(msg.sender);
        if (s.status != Status.IN_TRANSIT && s.status != Status.COMPROMISED) {
            revert InvalidStatus(shipmentId, s.status);
        }
        if (fromTimestamp > toTimestamp) revert InvalidAnchorRange(fromTimestamp, toTimestamp);

        _anchors[shipmentId].push(
            TelemetryAnchor({
                dataHash: dataHash,
                fromTimestamp: fromTimestamp,
                toTimestamp: toTimestamp,
                anchoredBy: msg.sender,
                anchoredAt: uint64(block.timestamp)
            })
        );

        emit TelemetryAnchored(shipmentId, dataHash, fromTimestamp, toTimestamp, msg.sender);
    }

    // ---------------------------------------------------------------------
    // Receiver actions
    // ---------------------------------------------------------------------

    /// @notice Receiver confirms physical delivery; escrow is settled by the pre-agreed rule.
    function confirmDelivery(uint256 shipmentId) external exists(shipmentId) {
        Shipment storage s = _shipments[shipmentId];
        if (msg.sender != s.receiver) revert Unauthorized(msg.sender);
        if (s.status != Status.IN_TRANSIT && s.status != Status.COMPROMISED) {
            revert InvalidStatus(shipmentId, s.status);
        }

        (uint256 carrierPayout, uint256 manufacturerRefund) = _settle(s, Status.DELIVERED, s.violationCount > 0);

        emit ShipmentDelivered(shipmentId, msg.sender, s.deliveredAt, carrierPayout, manufacturerRefund);
    }

    /// @notice Settle a shipment whose receiver never confirmed, once SETTLEMENT_TIMEOUT has
    ///         passed since transit started. Callable by the carrier or the manufacturer, so a
    ///         silent receiver can never lock the escrow forever.
    /// @dev The penalty is withheld unconditionally here, even with zero recorded violations.
    ///      Only the receiver can attest that the goods actually arrived; without that attestation
    ///      the contract has no proof of a successful delivery, and an absence of violations is not
    ///      one — a carrier that controls the gateway can produce it simply by withholding
    ///      telemetry. Settling at the penalised split makes silence no more profitable than a
    ///      reported excursion, so there is nothing to gain by hiding readings.
    function settleExpired(uint256 shipmentId) external exists(shipmentId) {
        Shipment storage s = _shipments[shipmentId];
        if (msg.sender != s.carrier && msg.sender != s.manufacturer) revert Unauthorized(msg.sender);
        if (s.status != Status.IN_TRANSIT && s.status != Status.COMPROMISED) {
            revert InvalidStatus(shipmentId, s.status);
        }
        uint64 availableAt = s.startedAt + SETTLEMENT_TIMEOUT;
        if (block.timestamp < availableAt) revert SettlementNotYetAvailable(availableAt);

        (uint256 carrierPayout, uint256 manufacturerRefund) = _settle(s, Status.EXPIRED, true);

        emit ShipmentExpired(shipmentId, msg.sender, carrierPayout, manufacturerRefund);
    }

    // ---------------------------------------------------------------------
    // Payments
    // ---------------------------------------------------------------------

    /// @notice Withdraw everything credited to the caller.
    function withdraw() external {
        uint256 amount = pendingWithdrawals[msg.sender];
        if (amount == 0) revert NothingToWithdraw();

        pendingWithdrawals[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();

        emit Withdrawal(msg.sender, amount);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function getSensor(address sensor) external view returns (SensorRecord memory) {
        return _sensors[sensor];
    }

    /// @notice Whether `sensor` may be assigned to a new shipment.
    function isSensorActive(address sensor) public view returns (bool) {
        return _sensors[sensor].active;
    }

    function getShipment(uint256 shipmentId) external view exists(shipmentId) returns (Shipment memory) {
        return _shipments[shipmentId];
    }

    function getViolations(uint256 shipmentId) external view exists(shipmentId) returns (Violation[] memory) {
        return _violations[shipmentId];
    }

    function getAnchors(uint256 shipmentId) external view exists(shipmentId) returns (TelemetryAnchor[] memory) {
        return _anchors[shipmentId];
    }

    /// @notice Payout split `confirmDelivery` applies: the penalty is withheld iff a temperature
    ///         violation was recorded.
    /// @dev Keyed on `violationCount`, an immutable fact, not on `status` — so the answer stays
    ///      correct after the shipment has moved on to DELIVERED.
    function previewSettlement(uint256 shipmentId)
        public
        view
        exists(shipmentId)
        returns (uint256 carrierPayout, uint256 manufacturerRefund)
    {
        Shipment storage s = _shipments[shipmentId];
        return _split(s, s.violationCount > 0);
    }

    /// @notice Payout split `settleExpired` applies: the penalty is always withheld, because
    ///         nobody confirmed the delivery. See `settleExpired` for the rationale.
    function previewExpiredSettlement(uint256 shipmentId)
        public
        view
        exists(shipmentId)
        returns (uint256 carrierPayout, uint256 manufacturerRefund)
    {
        return _split(_shipments[shipmentId], true);
    }

    /// @notice True once a temperature violation has been recorded, whatever the current status.
    function hasTemperatureViolation(uint256 shipmentId) external view exists(shipmentId) returns (bool) {
        return _shipments[shipmentId].violationCount > 0;
    }

    /// @notice Raw digest a sensor must sign (before the EIP-191 prefix is applied).
    /// @dev Bound to this chain and contract so a signature cannot be replayed elsewhere, and to
    ///      `telemetryHash` so the on-chain reading and the off-chain record stand or fall together.
    function readingDigest(
        uint256 shipmentId,
        uint32 sequence,
        int32 temperature,
        uint64 timestamp,
        bytes32 telemetryHash
    ) public view returns (bytes32) {
        return keccak256(
            abi.encode(block.chainid, address(this), shipmentId, sequence, temperature, timestamp, telemetryHash)
        );
    }

    // ---------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------

    function _requireActiveSensor(address sensor) private view {
        SensorRecord storage record = _sensors[sensor];
        if (record.registeredAt == 0) revert SensorNotRegistered(sensor);
        if (!record.active) revert SensorInactive(sensor);
    }

    /// @dev The one place the payout rule lives: the carrier is paid in full unless the penalty
    ///      applies, in which case `penaltyBps` of the escrow goes back to the manufacturer.
    function _split(Shipment storage s, bool penalise)
        private
        view
        returns (uint256 carrierPayout, uint256 manufacturerRefund)
    {
        if (penalise) manufacturerRefund = (s.payment * s.penaltyBps) / MAX_BPS;
        carrierPayout = s.payment - manufacturerRefund;
    }

    /// @dev Applies the settlement rule and credits pull-payment balances. Caller emits the event.
    function _settle(Shipment storage s, Status finalStatus, bool penalise)
        private
        returns (uint256 carrierPayout, uint256 manufacturerRefund)
    {
        (carrierPayout, manufacturerRefund) = _split(s, penalise);

        s.status = finalStatus;
        s.deliveredAt = uint64(block.timestamp);
        pendingWithdrawals[s.carrier] += carrierPayout;
        if (manufacturerRefund > 0) pendingWithdrawals[s.manufacturer] += manufacturerRefund;
    }

    function _recordViolation(uint256 shipmentId, Shipment storage s, int32 temperature, uint64 timestamp) private {
        uint32 index = s.violationCount;
        s.violationCount = index + 1;
        _violations[shipmentId].push(
            Violation({temperature: temperature, timestamp: timestamp, recordedAt: uint64(block.timestamp)})
        );

        if (s.status != Status.COMPROMISED) s.status = Status.COMPROMISED;

        emit TemperatureViolation(shipmentId, temperature, timestamp, index);
    }
}
