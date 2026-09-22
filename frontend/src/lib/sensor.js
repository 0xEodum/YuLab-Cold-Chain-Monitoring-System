/**
 * Browser-side sensor helpers. The digest/signature code is shared with the Hardhat scripts
 * (scripts/lib/sensor.js) so the contract, the CLI gateway and the UI can never drift apart.
 */
export { DEMO_DEVICE_ID } from "@backend/scripts/lib/accounts.js";
export {
  buildMeasurement,
  canonicalJson,
  readingDigest,
  signReading,
  telemetryBatchHash,
  telemetryRecordHash,
  verifyTelemetry,
} from "@backend/scripts/lib/sensor.js";

export const SPIKE_TEMP_C = 12.7;
export const SPIKE_START_INDEX = 4;
export const SPIKE_LENGTH = 2;
export const JITTER_C = 0.4;

/**
 * Sensor clock: the later of wall-clock and chain time (a dev node may have been
 * fast-forwarded), and strictly after the previous accepted reading as the contract requires.
 */
export function nextTimestamp({ now = Math.floor(Date.now() / 1000), chainNow = 0, lastReadingAt = 0, startedAt = 0 }) {
  return Math.max(now, Number(chainNow), Number(lastReadingAt) + 1, Number(startedAt));
}

/** Temperature (°C) for the i-th automatic reading under a profile ("normal" | "spike"). */
export function temperatureAt(index, { profile = "normal", baseTempC = 4.5, random = Math.random } = {}) {
  const inSpike = profile === "spike" && index >= SPIKE_START_INDEX && index < SPIKE_START_INDEX + SPIKE_LENGTH;
  const base = inSpike ? SPIKE_TEMP_C : baseTempC;
  return base + (random() * 2 - 1) * JITTER_C;
}
