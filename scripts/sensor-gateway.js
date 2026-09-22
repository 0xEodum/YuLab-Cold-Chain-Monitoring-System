/**
 * IoT sensor + gateway emulator. Signs temperature readings with the sensor key and relays
 * them to the ColdChain contract until the shipment is delivered or the process is stopped.
 *
 *   SHIPMENT_ID=1 npx hardhat run scripts/sensor-gateway.js --network localhost
 *
 * Environment:
 *   SHIPMENT_ID          (required) shipment to report for
 *   SENSOR_PRIVATE_KEY   sensor signing key (defaults to the demo key on hardhat/localhost)
 *   RELAYER_INDEX        index of the Hardhat account that pays for gas (default 2 = carrier)
 *   INTERVAL_MS          delay between readings (default 3000)
 *   BASE_TEMP_C          steady-state temperature in °C (default 4.5)
 *   PROFILE              "normal" | "spike" — spike injects an excursion to 12.7°C after a few readings
 *   ANCHOR_EVERY         anchor a telemetry batch hash every N readings, 0 disables (default 5)
 *   DEVICE_ID            off-chain device identity written into each record
 *
 * Each measurement is written twice: the full record goes to the off-chain store
 * (telemetry/<network>-shipment-<id>.json), and the chain gets the compact reading plus the hash
 * of that record. Both are covered by one sensor signature, so `verify-telemetry.js` can later
 * prove whether the store still holds what the device actually measured.
 */
import { network } from "hardhat";
import { buildMeasurement, signReading, telemetryBatchHash, toDeci, formatTemp } from "./lib/sensor.js";
import { loadDeployment } from "./lib/deployment.js";
import { DEMO_DEVICE_ID, sensorWalletFromEnv } from "./lib/accounts.js";
import { appendRecord, storePath } from "./lib/telemetry-store.js";

const { ethers, networkName } = await network.getOrCreate();

const STATUS_NAMES = ["CREATED", "IN_TRANSIT", "COMPROMISED", "DELIVERED", "CANCELLED", "EXPIRED"];
const TERMINAL_STATUSES = new Set([3n, 4n, 5n]);
const SPIKE_START_INDEX = 4;
const SPIKE_LENGTH = 2;
const SPIKE_TEMP_C = 12.7;
const JITTER_C = 0.4;
const MAX_CONSECUTIVE_FAILURES = 5;

const config = readConfig();
const { address, abi } = await loadDeployment(networkName);
const signers = await ethers.getSigners();
const relayer = signers[config.relayerIndex];
if (!relayer) throw new Error(`RELAYER_INDEX=${config.relayerIndex} is out of range (${signers.length} accounts)`);

const coldChain = new ethers.Contract(address, abi, relayer);
const { chainId } = await ethers.provider.getNetwork();
const sensor = sensorWalletFromEnv(networkName);

const shipment = await coldChain.getShipment(config.shipmentId);
if (shipment.sensor.toLowerCase() !== sensor.address.toLowerCase()) {
  throw new Error(`Shipment #${config.shipmentId} expects sensor ${shipment.sensor}, but gateway holds key for ${sensor.address}`);
}

console.log(`Gateway for shipment #${config.shipmentId} on "${networkName}" — contract ${address}`);
console.log(`Sensor ${sensor.address}, relayer ${relayer.address}, profile "${config.profile}", every ${config.intervalMs} ms`);
console.log(`Status: ${STATUS_NAMES[Number(shipment.status)]} (readings are accepted in IN_TRANSIT / COMPROMISED)`);
console.log(`Off-chain store: ${storePath(networkName, config.shipmentId)}\n`);

let batch = [];
let lastTimestamp = Number(shipment.lastReadingAt);
let sequence = Number(shipment.readingCount); // contract requires gap-free sequence numbers
let consecutiveFailures = 0;
let running = true;
process.on("SIGINT", () => {
  running = false;
  console.log("\nStopping gateway...");
});

for (let i = 0; running; i++) {
  const temperature = toDeci(temperatureAt(i));
  const timestamp = await nextTimestamp(lastTimestamp);

  try {
    const { record, telemetryHash } = buildMeasurement({
      shipmentId: config.shipmentId,
      sequence,
      temperature,
      timestamp,
      deviceId: config.deviceId,
    });
    const signature = await signReading(sensor, {
      chainId,
      contractAddress: address,
      shipmentId: config.shipmentId,
      sequence,
      temperature,
      timestamp,
      telemetryHash,
    });
    const receipt = await (
      await coldChain.submitReading(config.shipmentId, sequence, temperature, timestamp, telemetryHash, signature)
    ).wait();
    const violated = receipt.logs.some((log) => coldChain.interface.parseLog(log)?.name === "TemperatureViolation");
    // Only persist off-chain once the chain accepted the commitment, so the store never holds a
    // record that no on-chain reading vouches for.
    await appendRecord(networkName, config.shipmentId, record);
    lastTimestamp = timestamp;
    sequence += 1;
    consecutiveFailures = 0;
    batch = [...batch, record];
    console.log(`#${String(sequence - 1).padStart(4)}  ${new Date(timestamp * 1000).toISOString()}  ${formatTemp(temperature).padStart(7)}  ${violated ? "!! VIOLATION" : "ok"}  (block ${receipt.blockNumber})`);

    if (config.anchorEvery > 0 && batch.length >= config.anchorEvery) {
      await anchorBatch(batch);
      batch = [];
    }
  } catch (err) {
    const name = revertName(err);
    if (name === "InvalidStatus") {
      const { status } = await coldChain.getShipment(config.shipmentId);
      console.log(`Shipment is ${STATUS_NAMES[Number(status)]}; readings are no longer accepted.`);
      if (TERMINAL_STATUSES.has(status)) break;
    } else {
      consecutiveFailures += 1;
      console.error(`Reading rejected: ${name ?? err.shortMessage ?? err.message}`);
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        console.error(`Giving up after ${MAX_CONSECUTIVE_FAILURES} consecutive failures.`);
        process.exitCode = 1;
        break;
      }
    }
  }

  await sleep(config.intervalMs);
}

// ---------------------------------------------------------------------------

function readConfig() {
  const shipmentId = process.env.SHIPMENT_ID;
  if (!shipmentId || !/^\d+$/.test(shipmentId)) throw new Error("SHIPMENT_ID must be a positive integer");
  const profile = process.env.PROFILE ?? "normal";
  if (!["normal", "spike"].includes(profile)) throw new Error(`Unknown PROFILE "${profile}" (normal | spike)`);
  return {
    shipmentId: BigInt(shipmentId),
    relayerIndex: intEnv("RELAYER_INDEX", 2),
    intervalMs: intEnv("INTERVAL_MS", 3000),
    baseTempC: Number(process.env.BASE_TEMP_C ?? 4.5),
    anchorEvery: intEnv("ANCHOR_EVERY", 5),
    deviceId: process.env.DEVICE_ID ?? DEMO_DEVICE_ID,
    profile,
  };
}

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

/**
 * Sensor clock. Uses the later of wall-clock and chain time so the gateway keeps working
 * when a dev node has been fast-forwarded (e.g. by the demo script), and stays strictly
 * increasing as the contract requires.
 */
async function nextTimestamp(previous) {
  const { timestamp: chainNow } = await ethers.provider.getBlock("latest");
  return Math.max(Math.floor(Date.now() / 1000), chainNow, previous + 1);
}

function temperatureAt(index) {
  const inSpike = config.profile === "spike" && index >= SPIKE_START_INDEX && index < SPIKE_START_INDEX + SPIKE_LENGTH;
  const base = inSpike ? SPIKE_TEMP_C : config.baseTempC;
  return base + (Math.random() * 2 - 1) * JITTER_C;
}

async function anchorBatch(records) {
  const dataHash = telemetryBatchHash(records);
  try {
    await (
      await coldChain.anchorTelemetry(config.shipmentId, dataHash, records[0].measuredAt, records.at(-1).measuredAt)
    ).wait();
    console.log(`  anchored batch of ${records.length} records: ${dataHash}`);
  } catch (err) {
    // Anchoring is authorised for carrier/manufacturer only; a third-party relayer just skips it.
    console.error(`  anchor skipped: ${revertName(err) ?? err.shortMessage ?? err.message}`);
  }
}

function revertName(err) {
  const data = err?.data ?? err?.info?.error?.data;
  if (!data) return undefined;
  try {
    return coldChain.interface.parseError(data)?.name;
  } catch {
    return undefined;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
