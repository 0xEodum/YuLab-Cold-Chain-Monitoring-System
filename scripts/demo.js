/**
 * End-to-end walkthrough of the cold-chain scenario from the project documentation (§9):
 *   create → carrier accepts → normal readings → temperature violation → delivery → settlement.
 *
 *   npx hardhat run scripts/demo.js                      # in-process network
 *   npx hardhat run scripts/demo.js --network localhost  # against `npx hardhat node`
 *
 * Requires a Hardhat network because it fast-forwards block time between readings.
 */
import { network } from "hardhat";
import { existsSync } from "node:fs";
import { signReading, telemetryBatchHash, toDeci, formatTemp } from "./lib/sensor.js";
import { deploymentPath, loadDeployment } from "./lib/deployment.js";
import { DEMO_SENSOR_WALLET } from "./lib/accounts.js";

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
const batch = [];
for (const [sequence, celsius] of TEMPERATURE_PROFILE_C.entries()) {
  await time.increase(READING_INTERVAL_SEC);
  const timestamp = await time.latest();
  const temperature = toDeci(celsius);
  const signature = await signReading(sensor, chainId, contractAddress, shipmentId, sequence, temperature, timestamp);

  const receipt = await (
    await coldChain.connect(carrier).submitReading(shipmentId, sequence, temperature, timestamp, signature)
  ).wait();
  const violated = receipt.logs.some((l) => l.address === contractAddress && coldChain.interface.parseLog(l)?.name === "TemperatureViolation");
  batch.push({ timestamp, temperature });
  console.log(`    ${new Date(timestamp * 1000).toISOString()}  ${formatTemp(temperature).padStart(7)}  ${violated ? "!! TemperatureViolation" : "ok"}`);
}
await printStatus(shipmentId);

// Tampering attempts by the carrier
{
  const seq = TEMPERATURE_PROFILE_C.length;
  const ts = (await time.latest()) + 1;
  // (a) alter a signed value: 12.7°C relayed as 5.2°C
  const honest = await signReading(sensor, chainId, contractAddress, shipmentId, seq, toDeci(12.7), ts);
  await expectRejected(
    coldChain.connect(carrier).submitReading(shipmentId, seq, toDeci(5.2), ts, honest),
    "[4a] Carrier tried to relay 12.7°C as 5.2°C",
  );
  // (b) skip a reading: relay #seq+1 without ever submitting #seq
  const skipped = await signReading(sensor, chainId, contractAddress, shipmentId, seq + 1, toDeci(4.0), ts + 1);
  await expectRejected(
    coldChain.connect(carrier).submitReading(shipmentId, seq + 1, toDeci(4.0), ts + 1, skipped),
    `[4b] Carrier tried to skip reading #${seq} and relay #${seq + 1}`,
  );
}

// Anchor the off-chain telemetry batch
const dataHash = telemetryBatchHash(batch);
await (await coldChain.connect(carrier).anchorTelemetry(shipmentId, dataHash, batch[0].timestamp, batch.at(-1).timestamp)).wait();
console.log(`[5] Telemetry batch anchored: ${dataHash}`);

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
