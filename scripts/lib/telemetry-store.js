import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

/**
 * The off-chain half of the hybrid architecture, standing in for the telemetry database.
 *
 * Deliberately a plain, fully rewritable JSON file: the point of the demo is that the store is
 * NOT trusted. Anyone can edit it — that is exactly what `verify-telemetry.js` detects, by
 * re-hashing each record and comparing it with the commitment the sensor signed on-chain.
 */
const STORE_DIR = path.resolve("telemetry");

export function storePath(networkName, shipmentId) {
  return path.join(STORE_DIR, `${networkName}-shipment-${shipmentId}.json`);
}

/** @returns {Promise<Array<object>>} stored records, oldest first (empty if the store is new) */
export async function loadRecords(networkName, shipmentId) {
  try {
    const raw = JSON.parse(await readFile(storePath(networkName, shipmentId), "utf8"));
    return raw.records ?? [];
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

export async function saveRecords(networkName, shipmentId, records) {
  await mkdir(STORE_DIR, { recursive: true });
  const payload = {
    note: "Off-chain telemetry store. Integrity is proven against the chain, not by this file.",
    network: networkName,
    shipmentId: String(shipmentId),
    updatedAt: new Date().toISOString(),
    records,
  };
  await writeFile(storePath(networkName, shipmentId), JSON.stringify(payload, null, 2) + "\n");
  return payload;
}

/** Append one record, keeping the store sorted by sequence. */
export async function appendRecord(networkName, shipmentId, record) {
  const records = await loadRecords(networkName, shipmentId);
  const next = [...records.filter((r) => Number(r.sequence) !== Number(record.sequence)), record].sort(
    (a, b) => Number(a.sequence) - Number(b.sequence),
  );
  await saveRecords(networkName, shipmentId, next);
  return next;
}
