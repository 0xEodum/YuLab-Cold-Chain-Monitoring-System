/**
 * End-to-end walkthrough of the cold-chain scenario from the project documentation (§9):
 *   register sensor → create → carrier accepts → normal readings → temperature violation →
 *   off-chain tampering is detected → delivery → settlement.
 *
 *   npx hardhat run scripts/demo.js                      # in-process network
 *   npx hardhat run scripts/demo.js --network localhost  # against `npx hardhat node`
 *
 * Requires a Hardhat network because it fast-forwards block time between readings.
 */
import { network } from "hardhat";
import { existsSync } from "node:fs";
import {
  buildMeasurement,
  signReading,
  telemetryBatchHash,
  telemetryRecordHash,
  toDeci,
  formatTemp,
  verifyTelemetry,
} from "./lib/sensor.js";
import { deploymentPath, loadDeployment } from "./lib/deployment.js";
import { DEMO_DEVICE_ID, DEMO_SENSOR_WALLET, ensureDemoSensorRegistered } from "./lib/accounts.js";

const { ethers, networkHelpers, networkName } = await network.getOrCreate();
const { time } = networkHelpers;

const STATUS_NAMES = ["CREATED", "IN_TRANSIT", "COMPROMISED", "DELIVERED", "CANCELLED", "EXPIRED"];
const READING_INTERVAL_SEC = 5 * 60;
const TEMPERATURE_PROFILE_C = [4.2, 4.4, 5.1, 12.7, 12.1, 7.8, 5.0]; // one excursion above 8°C
const PAYMENT = ethers.parseEther("1");
const PENALTY_BPS = 2000;

const [, manufacturer, carrier, receiver] = await ethers.getSigners();
const sensor = DEMO_SENSOR_WALLET;
const { chainId } = await ethers.provider.getNetwork();

const coldChain = await getContract();
const contractAddress = await coldChain.getAddress();

console.log(`\n=== Cold chain demo on "${networkName}" — ColdChain @ ${contractAddress} ===`);
console.log(`Manufacturer: ${manufacturer.address}`);
console.log(`Carrier:      ${carrier.address}`);
console.log(`Receiver:     ${receiver.address}`);
console.log(`Sensor key:   ${sensor.address}\n`);

// --- Stage 0: sensor registry --------------------------------------------------
// A shipment may only be assigned to a registered, active sensor (FR-01).
const [registrar] = await ethers.getSigners();
const registration = await ensureDemoSensorRegistered(coldChain.connect(registrar), sensor.address);
const sensorRecord = await coldChain.getSensor(sensor.address);
console.log(`[0] Sensor ${registration} by registrar ${registrar.address}`);
console.log(`    device "${DEMO_DEVICE_ID}"`);
console.log(`    deviceIdHash ${sensorRecord.deviceIdHash}, active=${sensorRecord.active}`);

// An unregistered key cannot be assigned, however well-formed it looks.
await expectRejected(
  coldChain
    .connect(manufacturer)
    .createShipment("Rogue", carrier.address, receiver.address, ethers.Wallet.createRandom().address, toDeci(2), toDeci(8), PENALTY_BPS, {
      value: PAYMENT,
    }),
  `[0a] Manufacturer tried an unregistered sensor key`,
);

// --- Stage 1: create shipment ------------------------------------------------
const createTx = await coldChain
  .connect(manufacturer)
  .createShipment("Vaccine Batch A17", carrier.address, receiver.address, sensor.address, toDeci(2), toDeci(8), PENALTY_BPS, {
    value: PAYMENT,
  });
const createReceipt = await createTx.wait();
const shipmentId = coldChain.interface.parseLog(createReceipt.logs.find((l) => l.address === contractAddress)).args.shipmentId;
console.log(`[1] Manufacturer created shipment #${shipmentId}: 2.0°C..8.0°C, escrow ${ethers.formatEther(PAYMENT)} ETH, penalty ${PENALTY_BPS / 100}%`);
await printStatus(shipmentId);

// --- Stage 2: carrier accepts --------------------------------------------------
await (await coldChain.connect(carrier).startTransit(shipmentId)).wait();
console.log(`[2] Carrier accepted the shipment`);
await printStatus(shipmentId);

// --- Stage 3/4: monitoring & violation ------------------------------------------
console.log(`[3] Sensor readings (relayed by the carrier's gateway, signed by the sensor):`);
// The off-chain "database": full records live here, the chain only gets their hashes.
const offChainStore = [];
for (const [sequence, celsius] of TEMPERATURE_PROFILE_C.entries()) {
  await time.increase(READING_INTERVAL_SEC);
  const timestamp = await time.latest();
  const temperature = toDeci(celsius);
  const { record, telemetryHash } = buildMeasurement({
    shipmentId,
    sequence,
    temperature,
    timestamp,
    deviceId: DEMO_DEVICE_ID,
  });
  const signature = await signReading(sensor, {
    chainId,
    contractAddress,
    shipmentId,
    sequence,
    temperature,
    timestamp,
    telemetryHash,
  });

  const receipt = await (
    await coldChain.connect(carrier).submitReading(shipmentId, sequence, temperature, timestamp, telemetryHash, signature)
  ).wait();
  const violated = receipt.logs.some((l) => l.address === contractAddress && coldChain.interface.parseLog(l)?.name === "TemperatureViolation");
  offChainStore.push(record);
  console.log(`    ${new Date(timestamp * 1000).toISOString()}  ${formatTemp(temperature).padStart(7)}  ${violated ? "!! TemperatureViolation" : "ok"}  hash ${telemetryHash.slice(0, 12)}…`);
}
await printStatus(shipmentId);

// Tampering attempts by the carrier
{
  const seq = TEMPERATURE_PROFILE_C.length;
  const ts = (await time.latest()) + 1;
  const sign = (sequence, temperature, timestamp, telemetryHash) =>
    signReading(sensor, { chainId, contractAddress, shipmentId, sequence, temperature, timestamp, telemetryHash });

  // (a) alter a signed value: 12.7°C relayed as 5.2°C
  const hot = buildMeasurement({ shipmentId, sequence: seq, temperature: toDeci(12.7), timestamp: ts, deviceId: DEMO_DEVICE_ID });
  const honest = await sign(seq, toDeci(12.7), ts, hot.telemetryHash);
  await expectRejected(
    coldChain.connect(carrier).submitReading(shipmentId, seq, toDeci(5.2), ts, hot.telemetryHash, honest),
    "[4a] Carrier tried to relay 12.7°C as 5.2°C",
  );
  // (b) keep the signed reading, but point it at a doctored off-chain record
  const forgedHash = telemetryRecordHash({ ...hot.record, temperature: toDeci(5.2) });
  await expectRejected(
    coldChain.connect(carrier).submitReading(shipmentId, seq, toDeci(12.7), ts, forgedHash, honest),
    "[4b] Carrier kept the reading but swapped the off-chain record it commits to",
  );
  // (c) skip a reading: relay #seq+1 without ever submitting #seq
  const next = buildMeasurement({ shipmentId, sequence: seq + 1, temperature: toDeci(4.0), timestamp: ts + 1, deviceId: DEMO_DEVICE_ID });
  const skipped = await sign(seq + 1, toDeci(4.0), ts + 1, next.telemetryHash);
  await expectRejected(
    coldChain.connect(carrier).submitReading(shipmentId, seq + 1, toDeci(4.0), ts + 1, next.telemetryHash, skipped),
    `[4c] Carrier tried to skip reading #${seq} and relay #${seq + 1}`,
  );
}

// Anchor the off-chain telemetry batch
const dataHash = telemetryBatchHash(offChainStore);
await (
  await coldChain.connect(carrier).anchorTelemetry(shipmentId, dataHash, offChainStore[0].measuredAt, offChainStore.at(-1).measuredAt)
).wait();
console.log(`[5] Telemetry batch anchored: ${dataHash}`);

// --- Stage 5a/5b: audit the off-chain store against the chain ---------------------
// Nothing prevents editing the off-chain database — but every record was hashed by the sensor
// and that hash was signed together with the reading, so any edit is provable.
{
  const anchoredReadings = (await coldChain.queryFilter(coldChain.filters.ReadingSubmitted(shipmentId))).map((log) => ({
    sequence: Number(log.args.sequence),
    telemetryHash: log.args.telemetryHash,
  }));

  const clean = verifyTelemetry(offChainStore, anchoredReadings);
  console.log(`[5a] Audit of the untouched store: ${clean.ok ? "every record matches the chain" : "MISMATCH"}`);

  const doctored = offChainStore.map((r) => (r.sequence === 3 ? { ...r, temperature: toDeci(4.5) } : r));
  const audited = verifyTelemetry(doctored, anchoredReadings);
  const [flagged] = audited.results.filter((r) => r.status !== "ok");
  console.log(`[5b] Someone edits record #3 in the database: 12.7°C -> 4.5°C`);
  console.log(`     Audit result: ${audited.ok ? "not detected (!!)" : `record #${flagged.sequence} flagged as ${flagged.status}`}`);
  console.log(`     on-chain commitment: ${flagged?.expected}`);
  console.log(`     hash of stored data: ${flagged?.actual}`);
  console.log(`     The chain cannot be rewritten, so the database is what changed.`);
}

// --- Stage 5: delivery & settlement ----------------------------------------------
const [carrierPayout, manufacturerRefund] = await coldChain.previewSettlement(shipmentId);
await (await coldChain.connect(receiver).confirmDelivery(shipmentId)).wait();
console.log(`[6] Receiver confirmed delivery`);
await printStatus(shipmentId);
console.log(`    Settlement: carrier ${ethers.formatEther(carrierPayout)} ETH, manufacturer refund ${ethers.formatEther(manufacturerRefund)} ETH`);

for (const [label, signer] of [
  ["carrier", carrier],
  ["manufacturer", manufacturer],
]) {
  const owed = await coldChain.pendingWithdrawals(signer.address);
  if (owed === 0n) continue;
  await (await coldChain.connect(signer).withdraw()).wait();
  console.log(`    ${label} withdrew ${ethers.formatEther(owed)} ETH`);
}

const violations = await coldChain.getViolations(shipmentId);
console.log(`\nImmutable violation history for shipment #${shipmentId}:`);
for (const v of violations) {
  console.log(`  - ${formatTemp(v.temperature)} at ${new Date(Number(v.timestamp) * 1000).toISOString()}`);
}
console.log();

// ---------------------------------------------------------------------------

async function getContract() {
  if (existsSync(deploymentPath(networkName))) {
    const { address } = await loadDeployment(networkName);
    return ethers.getContractAt("ColdChain", address);
  }
  return ethers.deployContract("ColdChain");
}

async function printStatus(id) {
  const s = await coldChain.getShipment(id);
  console.log(`    status=${STATUS_NAMES[Number(s.status)]} readings=${s.readingCount} violations=${s.violationCount}`);
}

async function expectRejected(txPromise, label) {
  try {
    await txPromise;
    console.log(`    !!! ${label} — ACCEPTED, this must never happen`);
  } catch (err) {
    console.log(`${label} → rejected (${describeRevert(err)})`);
  }
}

function describeRevert(err) {
  const data = err?.data ?? err?.info?.error?.data;
  try {
    return coldChain.interface.parseError(data)?.name ?? err.shortMessage ?? err.message;
  } catch {
    return err.shortMessage ?? err.message;
  }
}
