import { getBytes, keccak256, AbiCoder } from "ethers";

/**
 * Off-chain mirror of `ColdChain.readingDigest`. Lets a sensor sign without an RPC call.
 * Kept in sync with the contract:
 *   keccak256(abi.encode(chainId, contract, shipmentId, sequence, temperature, timestamp)).
 */
export function readingDigest(chainId, contractAddress, shipmentId, sequence, temperature, timestamp) {
  return keccak256(
    AbiCoder.defaultAbiCoder().encode(
      ["uint256", "address", "uint256", "uint32", "int32", "uint64"],
      [chainId, contractAddress, shipmentId, sequence, temperature, timestamp],
    ),
  );
}

/** Produce the EIP-191 signature the contract expects for a reading. */
export async function signReading(sensorWallet, chainId, contractAddress, shipmentId, sequence, temperature, timestamp) {
  const digest = readingDigest(chainId, contractAddress, shipmentId, sequence, temperature, timestamp);
  return sensorWallet.signMessage(getBytes(digest));
}

/** Hash of an off-chain telemetry batch, as anchored on-chain. */
export function telemetryBatchHash(readings) {
  return keccak256(new TextEncoder().encode(JSON.stringify(readings)));
}

/** °C (number) -> tenths of °C (int32 as used on-chain). */
export function toDeci(celsius) {
  return Math.round(celsius * 10);
}

/** tenths of °C -> "x.y°C" */
export function formatTemp(deci) {
  return `${(Number(deci) / 10).toFixed(1)}°C`;
}
