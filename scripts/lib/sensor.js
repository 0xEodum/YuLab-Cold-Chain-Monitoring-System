import { concat, getBytes, keccak256, toUtf8Bytes, AbiCoder } from "ethers";

/**
 * The sensor side of the hybrid on-chain/off-chain split.
 *
 * A measurement exists in two places at once:
 *   - off-chain: the FULL telemetry record (device id, position, humidity, ... ) in ordinary storage;
 *   - on-chain:  a compact reading plus `telemetryHash` — the hash of that exact record.
 *
 * The sensor signs both together (see `readingDigest`), so the device vouches not only for the
 * temperature but for the record kept off-chain. Anyone can re-hash a stored record later and
 * compare it with the `ReadingSubmitted` log: if the off-chain store was edited, the hashes
 * diverge, and since the hash was signed by the sensor key it is the store that is proven wrong.
 */

// ---------------------------------------------------------------------------
// Canonical off-chain record
// ---------------------------------------------------------------------------

/**
 * Deterministic JSON: object keys sorted recursively, so two equal records always serialise to
 * the same bytes and therefore the same hash. Hashing raw `JSON.stringify` output would make the
 * hash depend on key insertion order — an integrity check that silently depends on how the record
 * happened to be built is not an integrity check.
 */
export function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`Cannot canonicalise non-finite number: ${value}`);
    return JSON.stringify(value);
  }
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  throw new TypeError(`Cannot canonicalise value of type ${typeof value}`);
}

/** Hash of one off-chain telemetry record, as committed to on-chain. */
export function telemetryRecordHash(record) {
  return keccak256(toUtf8Bytes(canonicalJson(record)));
}

/**
 * Build the off-chain record and the on-chain commitment for a single measurement.
 * `extra` carries whatever the device also reports (position, humidity, battery) — it is part of
 * the record, so it is covered by the hash and therefore by the sensor's signature.
 */
export function buildMeasurement({ shipmentId, sequence, temperature, timestamp, deviceId, extra = {} }) {
  // Numeric fields are normalised: a BigInt and a Number of equal value must not produce
  // different hashes just because of how the caller happened to hold them.
  const record = {
    shipmentId: String(shipmentId),
    sequence: Number(sequence),
    temperature: Number(temperature), // tenths of °C, exactly the value submitted on-chain
    measuredAt: Number(timestamp),
    deviceId,
    ...extra,
  };
  return { record, telemetryHash: telemetryRecordHash(record) };
}

/**
 * Hash of a batch of records, as anchored by `anchorTelemetry`. Built from the per-record hashes
 * (not from a re-serialisation of the batch) so a batch anchor and the individual readings commit
 * to exactly the same bytes.
 */
export function telemetryBatchHash(records) {
  return keccak256(concat(records.map(telemetryRecordHash)));
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

/**
 * Off-chain mirror of `ColdChain.readingDigest`. Lets a sensor sign without an RPC call.
 * Kept in sync with the contract:
 *   keccak256(abi.encode(chainId, contract, shipmentId, sequence, temperature, timestamp, telemetryHash)).
 */
export function readingDigest({ chainId, contractAddress, shipmentId, sequence, temperature, timestamp, telemetryHash }) {
  return keccak256(
    AbiCoder.defaultAbiCoder().encode(
      ["uint256", "address", "uint256", "uint32", "int32", "uint64", "bytes32"],
      [chainId, contractAddress, shipmentId, sequence, temperature, timestamp, telemetryHash],
    ),
  );
}

/** Produce the EIP-191 signature the contract expects for a reading. */
export async function signReading(sensorWallet, reading) {
  return sensorWallet.signMessage(getBytes(readingDigest(reading)));
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/**
 * Audit an off-chain telemetry store against the on-chain log.
 *
 * @param records  what the off-chain store currently holds
 * @param readings `ReadingSubmitted` data: [{ sequence, telemetryHash }, ...]
 * @returns {{ ok: boolean, results: Array<{sequence: number, status: string, expected?: string, actual?: string}> }}
 *          status: "ok" | "tampered" | "missing" (anchored on-chain but absent off-chain)
 *          | "unanchored" (present off-chain but never committed on-chain)
 */
export function verifyTelemetry(records, readings) {
  const bySequence = new Map(records.map((r) => [Number(r.sequence), r]));
  const results = readings.map(({ sequence, telemetryHash }) => {
    const seq = Number(sequence);
    const record = bySequence.get(seq);
    bySequence.delete(seq);
    if (!record) return { sequence: seq, status: "missing", expected: telemetryHash };
    const actual = telemetryRecordHash(record);
    return actual === telemetryHash
      ? { sequence: seq, status: "ok", expected: telemetryHash, actual }
      : { sequence: seq, status: "tampered", expected: telemetryHash, actual };
  });

  for (const [seq, record] of bySequence) {
    results.push({ sequence: seq, status: "unanchored", actual: telemetryRecordHash(record) });
  }
  results.sort((a, b) => a.sequence - b.sequence);
  return { ok: results.every((r) => r.status === "ok"), results };
}

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

/** °C (number) -> tenths of °C (int32 as used on-chain). */
export function toDeci(celsius) {
  return Math.round(celsius * 10);
}

/** tenths of °C -> "x.y°C" */
export function formatTemp(deci) {
  return `${(Number(deci) / 10).toFixed(1)}°C`;
}
