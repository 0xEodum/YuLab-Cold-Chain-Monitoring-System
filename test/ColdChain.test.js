import { expect } from "chai";
import { network } from "hardhat";
import { readingDigest as offchainReadingDigest, signReading as offchainSignReading } from "../scripts/lib/sensor.js";

const { ethers, networkHelpers } = await network.getOrCreate();
const { time } = networkHelpers;

// Temperatures are tenths of °C
const MIN_TEMP = 20; // 2.0°C
const MAX_TEMP = 80; // 8.0°C
const PENALTY_BPS = 2000; // 20%
const PAYMENT = ethers.parseEther("1");
const PRODUCT = "Vaccine Batch A17";

const Status = { CREATED: 0n, IN_TRANSIT: 1n, COMPROMISED: 2n, DELIVERED: 3n, CANCELLED: 4n, EXPIRED: 5n };

async function deployFixture() {
  const [deployer, manufacturer, carrier, receiver, stranger] = await ethers.getSigners();
  // The sensor only signs; it never sends transactions, so a random key is enough.
  const sensor = ethers.Wallet.createRandom();
  const coldChain = await ethers.deployContract("ColdChain", [], deployer);
  return { coldChain, manufacturer, carrier, receiver, stranger, sensor };
}

async function createShipment(ctx, overrides = {}) {
  const args = {
    product: PRODUCT,
    carrier: ctx.carrier.address,
    receiver: ctx.receiver.address,
    sensor: ctx.sensor.address,
    minTemp: MIN_TEMP,
    maxTemp: MAX_TEMP,
    penaltyBps: PENALTY_BPS,
    value: PAYMENT,
    ...overrides,
  };
  return ctx.coldChain
    .connect(ctx.manufacturer)
    .createShipment(args.product, args.carrier, args.receiver, args.sensor, args.minTemp, args.maxTemp, args.penaltyBps, {
      value: args.value,
    });
}

/** Deploy + create shipment #1 + carrier starts transit. */
async function inTransitFixture() {
  const ctx = await deployFixture();
  await createShipment(ctx);
  await ctx.coldChain.connect(ctx.carrier).startTransit(1);
  return { ...ctx, shipmentId: 1n };
}

async function signReading(ctx, shipmentId, sequence, temperature, timestamp, signer = ctx.sensor) {
  const digest = await ctx.coldChain.readingDigest(shipmentId, sequence, temperature, timestamp);
  return signer.signMessage(ethers.getBytes(digest));
}

/** Sign + submit a reading; `sequence` defaults to the next one the contract expects. */
async function submitReading(ctx, temperature, timestamp, opts = {}) {
  const { signer = ctx.sensor, relayer = ctx.stranger, shipmentId = ctx.shipmentId } = opts;
  const sequence = opts.sequence ?? (await ctx.coldChain.getShipment(shipmentId)).readingCount;
  const signature = await signReading(ctx, shipmentId, sequence, temperature, timestamp, signer);
  return ctx.coldChain.connect(relayer).submitReading(shipmentId, sequence, temperature, timestamp, signature);
}

describe("ColdChain", function () {
  describe("createShipment", function () {
    it("stores shipment terms, escrows payment and emits ShipmentCreated", async function () {
      const ctx = await networkHelpers.loadFixture(deployFixture);

      await expect(createShipment(ctx))
        .to.emit(ctx.coldChain, "ShipmentCreated")
        .withArgs(
          1n,
          ctx.manufacturer.address,
          ctx.carrier.address,
          ctx.receiver.address,
          ctx.sensor.address,
          MIN_TEMP,
          MAX_TEMP,
          PAYMENT,
          PENALTY_BPS,
          PRODUCT,
        );

      const s = await ctx.coldChain.getShipment(1);
      expect(s.manufacturer).to.equal(ctx.manufacturer.address);
      expect(s.carrier).to.equal(ctx.carrier.address);
      expect(s.receiver).to.equal(ctx.receiver.address);
      expect(s.sensor).to.equal(ctx.sensor.address);
      expect(s.minTemp).to.equal(MIN_TEMP);
      expect(s.maxTemp).to.equal(MAX_TEMP);
      expect(s.penaltyBps).to.equal(PENALTY_BPS);
      expect(s.status).to.equal(Status.CREATED);
      expect(s.payment).to.equal(PAYMENT);
      expect(s.product).to.equal(PRODUCT);
      expect(s.createdAt).to.equal(await time.latest());
      expect(await ethers.provider.getBalance(ctx.coldChain.target)).to.equal(PAYMENT);
      expect(await ctx.coldChain.shipmentCount()).to.equal(1n);
    });

    it("assigns sequential ids", async function () {
      const ctx = await networkHelpers.loadFixture(deployFixture);
      await createShipment(ctx);
      await createShipment(ctx);
      expect(await ctx.coldChain.shipmentCount()).to.equal(2n);
      expect((await ctx.coldChain.getShipment(2)).status).to.equal(Status.CREATED);
    });

    it("rejects zero addresses", async function () {
      const ctx = await networkHelpers.loadFixture(deployFixture);
      await expect(createShipment(ctx, { carrier: ethers.ZeroAddress }))
        .to.be.revertedWithCustomError(ctx.coldChain, "ZeroAddress")
        .withArgs("carrier");
      await expect(createShipment(ctx, { receiver: ethers.ZeroAddress }))
        .to.be.revertedWithCustomError(ctx.coldChain, "ZeroAddress")
        .withArgs("receiver");
      await expect(createShipment(ctx, { sensor: ethers.ZeroAddress }))
        .to.be.revertedWithCustomError(ctx.coldChain, "ZeroAddress")
        .withArgs("sensor");
    });

    it("rejects an empty or inverted temperature range", async function () {
      const ctx = await networkHelpers.loadFixture(deployFixture);
      await expect(createShipment(ctx, { minTemp: 80, maxTemp: 20 }))
        .to.be.revertedWithCustomError(ctx.coldChain, "InvalidTemperatureRange")
        .withArgs(80, 20);
      await expect(createShipment(ctx, { minTemp: 50, maxTemp: 50 })).to.be.revertedWithCustomError(
        ctx.coldChain,
        "InvalidTemperatureRange",
      );
    });

    it("rejects penalty above 100%", async function () {
      const ctx = await networkHelpers.loadFixture(deployFixture);
      await expect(createShipment(ctx, { penaltyBps: 10_001 }))
        .to.be.revertedWithCustomError(ctx.coldChain, "InvalidPenalty")
        .withArgs(10_001);
    });

    it("rejects zero payment", async function () {
      const ctx = await networkHelpers.loadFixture(deployFixture);
      await expect(createShipment(ctx, { value: 0n })).to.be.revertedWithCustomError(ctx.coldChain, "ZeroPayment");
    });

    it("reverts on unknown shipment ids", async function () {
      const ctx = await networkHelpers.loadFixture(deployFixture);
      await expect(ctx.coldChain.getShipment(0)).to.be.revertedWithCustomError(ctx.coldChain, "ShipmentNotFound");
      await expect(ctx.coldChain.getShipment(1)).to.be.revertedWithCustomError(ctx.coldChain, "ShipmentNotFound");
    });
  });

  describe("cancelShipment", function () {
    it("lets the manufacturer cancel before transit and reclaim the escrow", async function () {
      const ctx = await networkHelpers.loadFixture(deployFixture);
      await createShipment(ctx);

      await expect(ctx.coldChain.connect(ctx.manufacturer).cancelShipment(1))
        .to.emit(ctx.coldChain, "ShipmentCancelled")
        .withArgs(1n, PAYMENT);

      expect((await ctx.coldChain.getShipment(1)).status).to.equal(Status.CANCELLED);
      expect(await ctx.coldChain.pendingWithdrawals(ctx.manufacturer.address)).to.equal(PAYMENT);
      await expect(ctx.coldChain.connect(ctx.manufacturer).withdraw()).to.changeEtherBalances(
        ethers,
        [ctx.coldChain, ctx.manufacturer],
        [-PAYMENT, PAYMENT],
      );
    });

    it("rejects cancellation by anyone but the manufacturer", async function () {
      const ctx = await networkHelpers.loadFixture(deployFixture);
      await createShipment(ctx);
      await expect(ctx.coldChain.connect(ctx.carrier).cancelShipment(1))
        .to.be.revertedWithCustomError(ctx.coldChain, "Unauthorized")
        .withArgs(ctx.carrier.address);
    });

    it("rejects cancellation once the carrier has accepted", async function () {
      const ctx = await networkHelpers.loadFixture(inTransitFixture);
      await expect(ctx.coldChain.connect(ctx.manufacturer).cancelShipment(1))
        .to.be.revertedWithCustomError(ctx.coldChain, "InvalidStatus")
        .withArgs(1n, Status.IN_TRANSIT);
    });
  });

  describe("startTransit", function () {
    it("moves CREATED -> IN_TRANSIT when the carrier accepts", async function () {
      const ctx = await networkHelpers.loadFixture(deployFixture);
      await createShipment(ctx);

      await expect(ctx.coldChain.connect(ctx.carrier).startTransit(1)).to.emit(ctx.coldChain, "ShipmentStarted");

      const s = await ctx.coldChain.getShipment(1);
      expect(s.status).to.equal(Status.IN_TRANSIT);
      expect(s.startedAt).to.equal(await time.latest());
    });

    it("rejects acceptance by anyone but the assigned carrier", async function () {
      const ctx = await networkHelpers.loadFixture(deployFixture);
      await createShipment(ctx);
      await expect(ctx.coldChain.connect(ctx.stranger).startTransit(1)).to.be.revertedWithCustomError(
        ctx.coldChain,
        "Unauthorized",
      );
    });

    it("cannot be started twice", async function () {
      const ctx = await networkHelpers.loadFixture(inTransitFixture);
      await expect(ctx.coldChain.connect(ctx.carrier).startTransit(1))
        .to.be.revertedWithCustomError(ctx.coldChain, "InvalidStatus")
        .withArgs(1n, Status.IN_TRANSIT);
    });
  });

  describe("submitReading", function () {
    it("accepts an in-range reading relayed by anyone and keeps IN_TRANSIT", async function () {
      const ctx = await networkHelpers.loadFixture(inTransitFixture);
      const ts = await time.latest();

      await expect(submitReading(ctx, 42, ts))
        .to.emit(ctx.coldChain, "ReadingSubmitted")
        .withArgs(1n, 0, 42, ts, ctx.stranger.address, true)
        .and.not.to.emit(ctx.coldChain, "TemperatureViolation");

      const s = await ctx.coldChain.getShipment(1);
      expect(s.status).to.equal(Status.IN_TRANSIT);
      expect(s.readingCount).to.equal(1n);
      expect(s.violationCount).to.equal(0n);
      expect(s.lastReadingAt).to.equal(ts);
    });

    it("accepts boundary values as in range", async function () {
      const ctx = await networkHelpers.loadFixture(inTransitFixture);
      const ts = await time.latest();
      await submitReading(ctx, MIN_TEMP, ts);
      await submitReading(ctx, MAX_TEMP, ts + 1);
      expect((await ctx.coldChain.getShipment(1)).status).to.equal(Status.IN_TRANSIT);
    });

    it("records a violation and moves to COMPROMISED when the temperature is too high", async function () {
      const ctx = await networkHelpers.loadFixture(inTransitFixture);
      const ts = await time.latest();

      await expect(submitReading(ctx, 127, ts)).to.emit(ctx.coldChain, "TemperatureViolation").withArgs(1n, 127, ts, 0);

      const s = await ctx.coldChain.getShipment(1);
      expect(s.status).to.equal(Status.COMPROMISED);
      expect(s.violationCount).to.equal(1n);

      const violations = await ctx.coldChain.getViolations(1);
      expect(violations).to.have.length(1);
      expect(violations[0].temperature).to.equal(127);
      expect(violations[0].timestamp).to.equal(ts);
      expect(violations[0].recordedAt).to.equal(await time.latest());
    });

    it("records a violation when the temperature is too low (negative values)", async function () {
      const ctx = await networkHelpers.loadFixture(inTransitFixture);
      const ts = await time.latest();
      await expect(submitReading(ctx, -15, ts)).to.emit(ctx.coldChain, "TemperatureViolation").withArgs(1n, -15, ts, 0);
      expect((await ctx.coldChain.getShipment(1)).status).to.equal(Status.COMPROMISED);
    });

    it("keeps collecting readings and violations after the shipment is COMPROMISED", async function () {
      const ctx = await networkHelpers.loadFixture(inTransitFixture);
      const ts = await time.latest();

      await submitReading(ctx, 117, ts);
      await submitReading(ctx, 121, ts + 300);
      await submitReading(ctx, 78, ts + 600); // back in range — history is not erased

      const s = await ctx.coldChain.getShipment(1);
      expect(s.status).to.equal(Status.COMPROMISED);
      expect(s.readingCount).to.equal(3n);
      expect(s.violationCount).to.equal(2n);
      const violations = await ctx.coldChain.getViolations(1);
      expect(violations.map((v) => v.temperature)).to.deep.equal([117n, 121n]);
    });

    it("rejects a reading signed by an unregistered key", async function () {
      const ctx = await networkHelpers.loadFixture(inTransitFixture);
      const rogueSensor = ethers.Wallet.createRandom();
      await expect(submitReading(ctx, 42, await time.latest(), { signer: rogueSensor })).to.be.revertedWithCustomError(
        ctx.coldChain,
        "InvalidSignature",
      );
    });

    it("rejects a reading whose temperature was altered after signing", async function () {
      const ctx = await networkHelpers.loadFixture(inTransitFixture);
      const ts = await time.latest();
      const signature = await signReading(ctx, 1n, 0, 127, ts); // sensor saw 12.7°C
      // Carrier tries to relay it as 5.2°C
      await expect(ctx.coldChain.connect(ctx.carrier).submitReading(1, 0, 52, ts, signature)).to.be.revertedWithCustomError(
        ctx.coldChain,
        "InvalidSignature",
      );
    });

    it("rejects a malformed signature", async function () {
      const ctx = await networkHelpers.loadFixture(inTransitFixture);
      await expect(ctx.coldChain.submitReading(1, 0, 42, await time.latest(), "0x1234")).to.be.revertedWithCustomError(
        ctx.coldChain,
        "InvalidSignature",
      );
    });

    it("rejects replay of an already accepted reading", async function () {
      const ctx = await networkHelpers.loadFixture(inTransitFixture);
      const ts = await time.latest();
      await submitReading(ctx, 42, ts);
      await expect(submitReading(ctx, 42, ts, { sequence: 0 }))
        .to.be.revertedWithCustomError(ctx.coldChain, "SequenceMismatch")
        .withArgs(1, 0);
    });

    it("rejects a skipped sequence number, so a relay cannot omit an inconvenient reading", async function () {
      const ctx = await networkHelpers.loadFixture(inTransitFixture);
      const ts = await time.latest();
      await submitReading(ctx, 42, ts); // #0
      // Sensor produced #1 = 12.7°C (violation) and #2 = 4.5°C; carrier relays only #2
      await expect(submitReading(ctx, 45, ts + 20, { sequence: 2 }))
        .to.be.revertedWithCustomError(ctx.coldChain, "SequenceMismatch")
        .withArgs(1, 2);
      // ...and can only continue by submitting the violation first
      await expect(submitReading(ctx, 127, ts + 10, { sequence: 1 })).to.emit(ctx.coldChain, "TemperatureViolation");
      await submitReading(ctx, 45, ts + 20, { sequence: 2 });
      expect((await ctx.coldChain.getShipment(1)).readingCount).to.equal(3n);
    });

    it("rejects a reading whose timestamp is not later than the last accepted one", async function () {
      const ctx = await networkHelpers.loadFixture(inTransitFixture);
      const ts = await time.latest();
      await submitReading(ctx, 42, ts + 10);
      await expect(submitReading(ctx, 42, ts + 10))
        .to.be.revertedWithCustomError(ctx.coldChain, "StaleReading")
        .withArgs(ts + 10, ts + 10);
      await expect(submitReading(ctx, 42, ts + 5)).to.be.revertedWithCustomError(ctx.coldChain, "StaleReading");
    });

    it("rejects readings dated before transit started", async function () {
      const ctx = await networkHelpers.loadFixture(inTransitFixture);
      const { startedAt } = await ctx.coldChain.getShipment(1);
      await expect(submitReading(ctx, 42, startedAt - 1n))
        .to.be.revertedWithCustomError(ctx.coldChain, "ReadingBeforeTransit")
        .withArgs(startedAt - 1n, startedAt);
    });

    it("rejects readings too far in the future but accepts the exact clock-drift boundary", async function () {
      const ctx = await networkHelpers.loadFixture(inTransitFixture);
      const drift = await ctx.coldChain.MAX_CLOCK_DRIFT();
      // The next block will be mined at latest + 1, so latest + 1 + drift is exactly on the boundary
      const boundary = BigInt(await time.latest()) + 1n + drift;
      await expect(submitReading(ctx, 42, boundary + 1n)).to.be.revertedWithCustomError(ctx.coldChain, "ReadingFromFuture");
      await expect(submitReading(ctx, 42, boundary)).to.emit(ctx.coldChain, "ReadingSubmitted");
    });

    it("rejects readings for a shipment that is not in transit", async function () {
      const ctx = await networkHelpers.loadFixture(deployFixture);
      await createShipment(ctx);
      await expect(submitReading({ ...ctx, shipmentId: 1n }, 42, await time.latest()))
        .to.be.revertedWithCustomError(ctx.coldChain, "InvalidStatus")
        .withArgs(1n, Status.CREATED);
    });

    it("does not accept a signature made for a different shipment", async function () {
      const ctx = await networkHelpers.loadFixture(inTransitFixture);
      await createShipment(ctx); // shipment #2, same sensor
      await ctx.coldChain.connect(ctx.carrier).startTransit(2);
      const ts = await time.latest();
      const signature = await signReading(ctx, 2n, 0, 42, ts);
      await expect(ctx.coldChain.submitReading(1, 0, 42, ts, signature)).to.be.revertedWithCustomError(
        ctx.coldChain,
        "InvalidSignature",
      );
    });

    it("does not accept a signature made for a different contract instance", async function () {
      const ctx = await networkHelpers.loadFixture(inTransitFixture);
      const other = await ethers.deployContract("ColdChain");
      const ts = await time.latest();
      const foreignDigest = await other.readingDigest(1, 0, 42, ts);
      const signature = await ctx.sensor.signMessage(ethers.getBytes(foreignDigest));
      await expect(ctx.coldChain.submitReading(1, 0, 42, ts, signature)).to.be.revertedWithCustomError(
        ctx.coldChain,
        "InvalidSignature",
      );
    });

    it("accepts readings signed with the off-chain digest mirror used by the gateway scripts", async function () {
      const ctx = await networkHelpers.loadFixture(inTransitFixture);
      const { chainId } = await ethers.provider.getNetwork();
      const ts = await time.latest();

      expect(offchainReadingDigest(chainId, ctx.coldChain.target, 1n, 0, -15, ts)).to.equal(
        await ctx.coldChain.readingDigest(1, 0, -15, ts),
      );

      const signature = await offchainSignReading(ctx.sensor, chainId, ctx.coldChain.target, 1n, 0, 42, ts);
      await expect(ctx.coldChain.connect(ctx.stranger).submitReading(1, 0, 42, ts, signature))
        .to.emit(ctx.coldChain, "ReadingSubmitted")
        .withArgs(1n, 0, 42, ts, ctx.stranger.address, true);
    });
  });

  describe("anchorTelemetry", function () {
    const HASH = ethers.keccak256(ethers.toUtf8Bytes("telemetry batch"));

    it("stores an anchor submitted by the carrier", async function () {
      const ctx = await networkHelpers.loadFixture(inTransitFixture);
      const ts = await time.latest();

      await expect(ctx.coldChain.connect(ctx.carrier).anchorTelemetry(1, HASH, ts, ts + 3600))
        .to.emit(ctx.coldChain, "TelemetryAnchored")
        .withArgs(1n, HASH, ts, ts + 3600, ctx.carrier.address);

      const anchors = await ctx.coldChain.getAnchors(1);
      expect(anchors).to.have.length(1);
      expect(anchors[0].dataHash).to.equal(HASH);
      expect(anchors[0].fromTimestamp).to.equal(ts);
      expect(anchors[0].toTimestamp).to.equal(ts + 3600);
      expect(anchors[0].anchoredBy).to.equal(ctx.carrier.address);
      expect(anchors[0].anchoredAt).to.equal(await time.latest());
    });

    it("allows the manufacturer to anchor as well", async function () {
      const ctx = await networkHelpers.loadFixture(inTransitFixture);
      const ts = await time.latest();
      await expect(ctx.coldChain.connect(ctx.manufacturer).anchorTelemetry(1, HASH, ts, ts)).to.emit(
        ctx.coldChain,
        "TelemetryAnchored",
      );
    });

    it("rejects anchors from third parties", async function () {
      const ctx = await networkHelpers.loadFixture(inTransitFixture);
      const ts = await time.latest();
      await expect(ctx.coldChain.connect(ctx.stranger).anchorTelemetry(1, HASH, ts, ts)).to.be.revertedWithCustomError(
        ctx.coldChain,
        "Unauthorized",
      );
    });

    it("rejects an inverted time range", async function () {
      const ctx = await networkHelpers.loadFixture(inTransitFixture);
      await expect(ctx.coldChain.connect(ctx.carrier).anchorTelemetry(1, HASH, 100, 99))
        .to.be.revertedWithCustomError(ctx.coldChain, "InvalidAnchorRange")
        .withArgs(100, 99);
    });

    it("rejects anchors before transit and after delivery", async function () {
      const ctx = await networkHelpers.loadFixture(deployFixture);
      await createShipment(ctx);
      await expect(ctx.coldChain.connect(ctx.carrier).anchorTelemetry(1, HASH, 1, 2))
        .to.be.revertedWithCustomError(ctx.coldChain, "InvalidStatus")
        .withArgs(1n, Status.CREATED);

      await ctx.coldChain.connect(ctx.carrier).startTransit(1);
      await ctx.coldChain.connect(ctx.receiver).confirmDelivery(1);
      await expect(ctx.coldChain.connect(ctx.carrier).anchorTelemetry(1, HASH, 1, 2))
        .to.be.revertedWithCustomError(ctx.coldChain, "InvalidStatus")
        .withArgs(1n, Status.DELIVERED);
    });
  });

  describe("confirmDelivery & settlement", function () {
    it("pays the carrier in full when no violation occurred", async function () {
      const ctx = await networkHelpers.loadFixture(inTransitFixture);
      await submitReading(ctx, 45, await time.latest());

      expect(await ctx.coldChain.previewSettlement(1)).to.deep.equal([PAYMENT, 0n]);

      await expect(ctx.coldChain.connect(ctx.receiver).confirmDelivery(1))
        .to.emit(ctx.coldChain, "ShipmentDelivered")
        .withArgs(1n, ctx.receiver.address, (await time.latest()) + 1, PAYMENT, 0n);

      const s = await ctx.coldChain.getShipment(1);
      expect(s.status).to.equal(Status.DELIVERED);
      expect(s.deliveredAt).to.equal(await time.latest());
      expect(await ctx.coldChain.pendingWithdrawals(ctx.carrier.address)).to.equal(PAYMENT);
      expect(await ctx.coldChain.pendingWithdrawals(ctx.manufacturer.address)).to.equal(0n);
      expect(await ctx.coldChain.hasTemperatureViolation(1)).to.equal(false);
    });

    it("applies the penalty split when the shipment was compromised", async function () {
      const ctx = await networkHelpers.loadFixture(inTransitFixture);
      await submitReading(ctx, 127, await time.latest());

      const expectedRefund = (PAYMENT * BigInt(PENALTY_BPS)) / 10_000n; // 0.2 ETH
      const expectedPayout = PAYMENT - expectedRefund; // 0.8 ETH
      expect(await ctx.coldChain.previewSettlement(1)).to.deep.equal([expectedPayout, expectedRefund]);

      await expect(ctx.coldChain.connect(ctx.receiver).confirmDelivery(1))
        .to.emit(ctx.coldChain, "ShipmentDelivered")
        .withArgs(1n, ctx.receiver.address, (await time.latest()) + 1, expectedPayout, expectedRefund);

      expect(await ctx.coldChain.pendingWithdrawals(ctx.carrier.address)).to.equal(expectedPayout);
      expect(await ctx.coldChain.pendingWithdrawals(ctx.manufacturer.address)).to.equal(expectedRefund);

      // The violation history survives delivery
      const s = await ctx.coldChain.getShipment(1);
      expect(s.status).to.equal(Status.DELIVERED);
      expect(s.violationCount).to.equal(1n);
      expect(await ctx.coldChain.getViolations(1)).to.have.length(1);

      // ...and so does the preview: it is keyed on violationCount, not on the transient
      // COMPROMISED status, so a client reading it after settlement still sees the real split.
      expect(await ctx.coldChain.hasTemperatureViolation(1)).to.equal(true);
      expect(await ctx.coldChain.previewSettlement(1)).to.deep.equal([expectedPayout, expectedRefund]);
    });

    it("withholds the entire payment with a 100% penalty", async function () {
      const ctx = await networkHelpers.loadFixture(deployFixture);
      await createShipment(ctx, { penaltyBps: 10_000 });
      await ctx.coldChain.connect(ctx.carrier).startTransit(1);
      await submitReading({ ...ctx, shipmentId: 1n }, 127, await time.latest());
      await ctx.coldChain.connect(ctx.receiver).confirmDelivery(1);

      expect(await ctx.coldChain.pendingWithdrawals(ctx.carrier.address)).to.equal(0n);
      expect(await ctx.coldChain.pendingWithdrawals(ctx.manufacturer.address)).to.equal(PAYMENT);
    });

    it("rejects confirmation from anyone but the receiver", async function () {
      const ctx = await networkHelpers.loadFixture(inTransitFixture);
      await expect(ctx.coldChain.connect(ctx.carrier).confirmDelivery(1)).to.be.revertedWithCustomError(
        ctx.coldChain,
        "Unauthorized",
      );
    });

    it("rejects confirmation before transit and after delivery", async function () {
      const ctx = await networkHelpers.loadFixture(deployFixture);
      await createShipment(ctx);
      await expect(ctx.coldChain.connect(ctx.receiver).confirmDelivery(1))
        .to.be.revertedWithCustomError(ctx.coldChain, "InvalidStatus")
        .withArgs(1n, Status.CREATED);

      await ctx.coldChain.connect(ctx.carrier).startTransit(1);
      await ctx.coldChain.connect(ctx.receiver).confirmDelivery(1);
      await expect(ctx.coldChain.connect(ctx.receiver).confirmDelivery(1))
        .to.be.revertedWithCustomError(ctx.coldChain, "InvalidStatus")
        .withArgs(1n, Status.DELIVERED);
    });

    it("stops accepting readings once delivered", async function () {
      const ctx = await networkHelpers.loadFixture(inTransitFixture);
      await ctx.coldChain.connect(ctx.receiver).confirmDelivery(1);
      await expect(submitReading(ctx, 42, await time.latest()))
        .to.be.revertedWithCustomError(ctx.coldChain, "InvalidStatus")
        .withArgs(1n, Status.DELIVERED);
    });
  });

  describe("settleExpired", function () {
    it("withholds the penalty even with a clean record: no receiver confirmation, no full payout", async function () {
      const ctx = await networkHelpers.loadFixture(inTransitFixture);
      await submitReading(ctx, 45, await time.latest());
      const timeout = await ctx.coldChain.SETTLEMENT_TIMEOUT();
      await time.increase(timeout);

      const expectedRefund = (PAYMENT * BigInt(PENALTY_BPS)) / 10_000n; // 0.2 ETH
      const expectedPayout = PAYMENT - expectedRefund; // 0.8 ETH
      // confirmDelivery would pay in full; settling without the receiver does not.
      expect(await ctx.coldChain.previewSettlement(1)).to.deep.equal([PAYMENT, 0n]);
      expect(await ctx.coldChain.previewExpiredSettlement(1)).to.deep.equal([expectedPayout, expectedRefund]);

      await expect(ctx.coldChain.connect(ctx.carrier).settleExpired(1))
        .to.emit(ctx.coldChain, "ShipmentExpired")
        .withArgs(1n, ctx.carrier.address, expectedPayout, expectedRefund);

      const s = await ctx.coldChain.getShipment(1);
      expect(s.status).to.equal(Status.EXPIRED);
      expect(s.deliveredAt).to.equal(await time.latest());
      expect(await ctx.coldChain.pendingWithdrawals(ctx.carrier.address)).to.equal(expectedPayout);
      expect(await ctx.coldChain.pendingWithdrawals(ctx.manufacturer.address)).to.equal(expectedRefund);
    });

    it("gives a silent carrier nothing to gain by withholding telemetry", async function () {
      // The attack the rule closes: the gateway reports nothing at all, so violationCount stays 0,
      // and after the timeout the carrier claims a "flawless" delivery. Shipment #1 is silent,
      // #2 reports an excursion honestly — both must settle identically.
      const ctx = await networkHelpers.loadFixture(inTransitFixture);
      await createShipment(ctx);
      await ctx.coldChain.connect(ctx.carrier).startTransit(2);
      await submitReading(ctx, 127, await time.latest(), { shipmentId: 2n });
      await time.increase(await ctx.coldChain.SETTLEMENT_TIMEOUT());

      expect((await ctx.coldChain.getShipment(1)).readingCount).to.equal(0n);
      expect(await ctx.coldChain.previewExpiredSettlement(1)).to.deep.equal(
        await ctx.coldChain.previewExpiredSettlement(2),
      );

      await ctx.coldChain.connect(ctx.carrier).settleExpired(1);
      const silentPayout = await ctx.coldChain.pendingWithdrawals(ctx.carrier.address);
      await ctx.coldChain.connect(ctx.carrier).settleExpired(2);
      const honestPayout = (await ctx.coldChain.pendingWithdrawals(ctx.carrier.address)) - silentPayout;

      expect(silentPayout).to.equal(honestPayout);
    });

    it("applies the same penalty when the manufacturer settles a compromised shipment", async function () {
      const ctx = await networkHelpers.loadFixture(inTransitFixture);
      await submitReading(ctx, 127, await time.latest());
      await time.increase(await ctx.coldChain.SETTLEMENT_TIMEOUT());

      await expect(ctx.coldChain.connect(ctx.manufacturer).settleExpired(1))
        .to.emit(ctx.coldChain, "ShipmentExpired")
        .withArgs(1n, ctx.manufacturer.address, ethers.parseEther("0.8"), ethers.parseEther("0.2"));
      expect(await ctx.coldChain.pendingWithdrawals(ctx.manufacturer.address)).to.equal(ethers.parseEther("0.2"));
    });

    it("rejects settlement before the timeout has elapsed", async function () {
      const ctx = await networkHelpers.loadFixture(inTransitFixture);
      const { startedAt } = await ctx.coldChain.getShipment(1);
      const availableAt = startedAt + (await ctx.coldChain.SETTLEMENT_TIMEOUT());
      await time.increaseTo(availableAt - 2n);
      await expect(ctx.coldChain.connect(ctx.carrier).settleExpired(1))
        .to.be.revertedWithCustomError(ctx.coldChain, "SettlementNotYetAvailable")
        .withArgs(availableAt);
      // Exactly at availableAt it goes through (the next block is mined at availableAt - 1 + 1)
      await time.increaseTo(availableAt - 1n);
      await expect(ctx.coldChain.connect(ctx.carrier).settleExpired(1)).to.emit(ctx.coldChain, "ShipmentExpired");
    });

    it("rejects settlement by the receiver or third parties", async function () {
      const ctx = await networkHelpers.loadFixture(inTransitFixture);
      await time.increase(await ctx.coldChain.SETTLEMENT_TIMEOUT());
      for (const signer of [ctx.receiver, ctx.stranger]) {
        await expect(ctx.coldChain.connect(signer).settleExpired(1))
          .to.be.revertedWithCustomError(ctx.coldChain, "Unauthorized")
          .withArgs(signer.address);
      }
    });

    it("rejects settlement of shipments that are not in transit", async function () {
      const ctx = await networkHelpers.loadFixture(inTransitFixture);
      await ctx.coldChain.connect(ctx.receiver).confirmDelivery(1);
      await time.increase(await ctx.coldChain.SETTLEMENT_TIMEOUT());
      await expect(ctx.coldChain.connect(ctx.carrier).settleExpired(1))
        .to.be.revertedWithCustomError(ctx.coldChain, "InvalidStatus")
        .withArgs(1n, Status.DELIVERED);
    });

    it("cannot be settled twice: receiver confirmation after expiry is rejected", async function () {
      const ctx = await networkHelpers.loadFixture(inTransitFixture);
      await time.increase(await ctx.coldChain.SETTLEMENT_TIMEOUT());
      await ctx.coldChain.connect(ctx.carrier).settleExpired(1);
      await expect(ctx.coldChain.connect(ctx.receiver).confirmDelivery(1))
        .to.be.revertedWithCustomError(ctx.coldChain, "InvalidStatus")
        .withArgs(1n, Status.EXPIRED);
    });
  });

  describe("withdraw", function () {
    it("transfers the credited balance exactly once", async function () {
      const ctx = await networkHelpers.loadFixture(inTransitFixture);
      await submitReading(ctx, 127, await time.latest());
      await ctx.coldChain.connect(ctx.receiver).confirmDelivery(1);

      const carrierShare = ethers.parseEther("0.8");
      const manufacturerShare = ethers.parseEther("0.2");

      await expect(ctx.coldChain.connect(ctx.carrier).withdraw())
        .to.emit(ctx.coldChain, "Withdrawal")
        .withArgs(ctx.carrier.address, carrierShare);
      await expect(ctx.coldChain.connect(ctx.manufacturer).withdraw()).to.changeEtherBalances(
        ethers,
        [ctx.coldChain, ctx.manufacturer],
        [-manufacturerShare, manufacturerShare],
      );

      expect(await ethers.provider.getBalance(ctx.coldChain.target)).to.equal(0n);
      await expect(ctx.coldChain.connect(ctx.carrier).withdraw()).to.be.revertedWithCustomError(
        ctx.coldChain,
        "NothingToWithdraw",
      );
    });

    it("accumulates credits across several shipments", async function () {
      const ctx = await networkHelpers.loadFixture(deployFixture);
      await createShipment(ctx);
      await createShipment(ctx);
      await ctx.coldChain.connect(ctx.carrier).startTransit(1);
      await ctx.coldChain.connect(ctx.carrier).startTransit(2);
      await ctx.coldChain.connect(ctx.receiver).confirmDelivery(1);
      await ctx.coldChain.connect(ctx.receiver).confirmDelivery(2);

      expect(await ctx.coldChain.pendingWithdrawals(ctx.carrier.address)).to.equal(PAYMENT * 2n);
      await expect(ctx.coldChain.connect(ctx.carrier).withdraw()).to.changeEtherBalances(
        ethers,
        [ctx.coldChain, ctx.carrier],
        [-(PAYMENT * 2n), PAYMENT * 2n],
      );
    });

    it("rejects withdrawal when the caller is not owed anything", async function () {
      const ctx = await networkHelpers.loadFixture(deployFixture);
      await expect(ctx.coldChain.connect(ctx.stranger).withdraw()).to.be.revertedWithCustomError(
        ctx.coldChain,
        "NothingToWithdraw",
      );
    });
  });
});

describe("ColdChain withdraw failure path", function () {
  it("reverts with TransferFailed and keeps the credit when the recipient rejects ETH", async function () {
    const ctx = await networkHelpers.loadFixture(deployFixture);
    const rejecting = await ethers.deployContract("RejectingManufacturer", [ctx.coldChain.target]);
    await rejecting.createAndCancel(ctx.carrier.address, ctx.receiver.address, ctx.sensor.address, { value: PAYMENT });
    expect(await ctx.coldChain.pendingWithdrawals(rejecting.target)).to.equal(PAYMENT);

    await expect(rejecting.withdraw()).to.be.revertedWithCustomError(ctx.coldChain, "TransferFailed");

    // State was rolled back together with the revert — nothing is lost
    expect(await ctx.coldChain.pendingWithdrawals(rejecting.target)).to.equal(PAYMENT);
    expect(await ethers.provider.getBalance(ctx.coldChain.target)).to.equal(PAYMENT);
  });
});
