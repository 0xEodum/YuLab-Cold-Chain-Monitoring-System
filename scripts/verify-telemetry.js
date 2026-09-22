/**
 * Audit the off-chain telemetry store of a shipment against the blockchain.
 *
 *   SHIPMENT_ID=1 npx hardhat run scripts/verify-telemetry.js --network localhost
 *
 * Environment:
 *   SHIPMENT_ID  (required) shipment to audit
 *   TAMPER       "<sequence>:<temperatureC>" — rewrite one stored record before auditing, to
 *                demonstrate that editing the store is detectable (it does NOT touch the chain)
 *
 * This is the hybrid architecture's whole point. The store is an ordinary, fully writable file:
 * nothing stops anyone from editing it. But every record was hashed by the sensor, and that hash
 * was signed together with the reading and written to the chain. Re-hashing the stored record and
 * comparing it with the `ReadingSubmitted` log therefore proves whether the store still holds
 * what the device actually measured — and the sensor's signature proves it is the store, not the
 * chain, that moved.
 */
import { network } from "hardhat";
import { telemetryRecordHash, toDeci, formatTemp, verifyTelemetry } from "./lib/sensor.js";
import { loadDeployment } from "./lib/deployment.js";
import { loadRecords, saveRecords, storePath } from "./lib/telemetry-store.js";

const { ethers, networkName } = await network.getOrCreate();

const STATUS_LABELS = {
  ok: "ok — hash matches the on-chain commitment",
  tampered: "TAMPERED — stored record does not hash to the on-chain commitment",
  missing: "MISSING — committed on-chain but absent from the store",
  unanchored: "UNANCHORED — present in the store but never committed on-chain",
};

const shipmentId = readShipmentId();
const { address, abi } = await loadDeployment(networkName);
const coldChain = new ethers.Contract(address, abi, ethers.provider);

let records = await loadRecords(networkName, shipmentId);
if (records.length === 0) {
  throw new Error(`Off-chain store ${storePath(networkName, shipmentId)} is empty. Run the gateway first.`);
}

console.log(`\n=== Telemetry audit — shipment #${shipmentId} on "${networkName}" ===`);
console.log(`Off-chain store: ${storePath(networkName, shipmentId)} (${records.length} records)`);
console.log(`On-chain log:    ColdChain @ ${address}\n`);

const tamper = readTamper();
if (tamper) {
  records = await applyTamper(records, tamper);
}

const logs = await coldChain.queryFilter(coldChain.filters.ReadingSubmitted(shipmentId));
const readings = logs.map((log) => ({
  sequence: Number(log.args.sequence),
  temperature: Number(log.args.temperature),
  telemetryHash: log.args.telemetryHash,
}));
console.log(`Read ${readings.length} ReadingSubmitted events from the chain.\n`);

const { ok, results } = verifyTelemetry(records, readings);

for (const r of results) {
  console.log(`  #${String(r.sequence).padStart(3)}  ${STATUS_LABELS[r.status]}`);
  if (r.status === "tampered") {
    console.log(`        on-chain commitment: ${r.expected}`);
    console.log(`        hash of stored data: ${r.actual}`);
  }
  if (r.status === "missing") console.log(`        on-chain commitment: ${r.expected}`);
}

const anchors = await coldChain.getAnchors(shipmentId);
console.log(`\n${anchors.length} telemetry batch anchor(s) on-chain.`);

if (ok) {
  console.log(`\nRESULT: store matches the chain — every record is the one the sensor signed.\n`);
} else {
  const bad = results.filter((r) => r.status !== "ok");
  console.log(`\nRESULT: ${bad.length} of ${results.length} record(s) do NOT match the chain.`);
  console.log(`The chain cannot be rewritten, so the off-chain store is what changed.\n`);
  process.exitCode = 1;
}

// ---------------------------------------------------------------------------

function readShipmentId() {
  const raw = process.env.SHIPMENT_ID;
  if (!raw || !/^\d+$/.test(raw)) throw new Error("SHIPMENT_ID must be a positive integer");
  return BigInt(raw);
}

/** @returns {{sequence: number, celsius: number} | undefined} */
function readTamper() {
  const raw = process.env.TAMPER;
  if (!raw) return undefined;
  const match = /^(\d+):(-?\d+(?:\.\d+)?)$/.exec(raw);
  if (!match) throw new Error(`TAMPER must look like "<sequence>:<temperatureC>", got "${raw}"`);
  return { sequence: Number(match[1]), celsius: Number(match[2]) };
}

async function applyTamper(current, { sequence, celsius }) {
  const index = current.findIndex((r) => Number(r.sequence) === sequence);
  if (index === -1) throw new Error(`No record #${sequence} in the store`);

  const before = current[index];
  const after = { ...before, temperature: toDeci(celsius) };
  const next = current.map((r, i) => (i === index ? after : r));
  await saveRecords(networkName, shipmentId, next);

  console.log(`TAMPER: rewrote record #${sequence} in the off-chain store only`);
  console.log(`        ${formatTemp(before.temperature)} -> ${formatTemp(after.temperature)}`);
  console.log(`        hash ${telemetryRecordHash(before)}`);
  console.log(`          -> ${telemetryRecordHash(after)}\n`);
  return next;
}
