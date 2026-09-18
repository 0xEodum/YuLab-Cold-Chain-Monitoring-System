import { Contract, Interface, JsonRpcProvider } from "ethers";
import deployment from "@backend/deployments/localhost.json";

export const RPC_URL = import.meta.env.VITE_RPC_URL ?? "http://127.0.0.1:8545";
export const CONTRACT_ADDRESS = deployment.address;
export const CONTRACT_ABI = deployment.abi;
export const EXPECTED_CHAIN_ID = BigInt(deployment.chainId);

export const coldChainInterface = new Interface(CONTRACT_ABI);

export function createProvider(url = RPC_URL) {
  // staticNetwork: skip the eth_chainId round-trip on every call (the chain never changes here)
  return new JsonRpcProvider(url, undefined, { staticNetwork: true });
}

/** Read-only contract bound to the provider. */
export function readContract(provider) {
  return new Contract(CONTRACT_ADDRESS, CONTRACT_ABI, provider);
}

/** Contract bound to a signer (a role wallet connected to the provider). */
export function writeContract(signer) {
  return new Contract(CONTRACT_ADDRESS, CONTRACT_ABI, signer);
}

/**
 * Health check for the connection banner: is the node up, is it the expected chain,
 * and is the contract actually deployed at the recorded address.
 */
export async function probeChain(provider) {
  const network = await provider.getNetwork();
  const code = await provider.getCode(CONTRACT_ADDRESS);
  return {
    chainId: network.chainId,
    chainMatches: network.chainId === EXPECTED_CHAIN_ID,
    contractDeployed: code !== "0x",
  };
}

/** Normalise a `getShipment` struct (ethers Result) into a plain object with JS-friendly types. */
export function toShipment(id, raw) {
  return {
    id: Number(id),
    manufacturer: raw.manufacturer,
    carrier: raw.carrier,
    receiver: raw.receiver,
    sensor: raw.sensor,
    minTemp: Number(raw.minTemp),
    maxTemp: Number(raw.maxTemp),
    penaltyBps: Number(raw.penaltyBps),
    status: Number(raw.status),
    createdAt: Number(raw.createdAt),
    startedAt: Number(raw.startedAt),
    deliveredAt: Number(raw.deliveredAt),
    lastReadingAt: Number(raw.lastReadingAt),
    readingCount: Number(raw.readingCount),
    violationCount: Number(raw.violationCount),
    payment: BigInt(raw.payment),
    product: raw.product,
  };
}

export function toViolation(raw) {
  return { temperature: Number(raw.temperature), timestamp: Number(raw.timestamp), recordedAt: Number(raw.recordedAt) };
}

export function toAnchor(raw) {
  return {
    dataHash: raw.dataHash,
    fromTimestamp: Number(raw.fromTimestamp),
    toTimestamp: Number(raw.toTimestamp),
    anchoredBy: raw.anchoredBy,
    anchoredAt: Number(raw.anchoredAt),
  };
}

/** `ReadingSubmitted` event log -> plain reading with block provenance (for the immutability view). */
export function toReading(log) {
  return {
    sequence: Number(log.args.sequence),
    temperature: Number(log.args.temperature),
    timestamp: Number(log.args.timestamp),
    reporter: log.args.reporter,
    inRange: Boolean(log.args.inRange),
    blockNumber: log.blockNumber,
    txHash: log.transactionHash,
  };
}

/** Any contract event log -> a generic timeline entry. */
export function toEvent(log) {
  const args = {};
  for (const [key, value] of Object.entries(log.args.toObject())) {
    args[key] = typeof value === "bigint" ? value.toString() : value;
  }
  return {
    name: log.fragment.name,
    args,
    blockNumber: log.blockNumber,
    txHash: log.transactionHash,
    logIndex: log.index,
  };
}

/**
 * Payout split to display. While a shipment is active `previewSettlement` is authoritative;
 * once it is settled the contract's preview no longer applies the penalty (status is no longer
 * COMPROMISED), so the figures come from the settlement event instead.
 */
export function resolveSettlement(preview, events) {
  const settled = events.find((e) => e.name === "ShipmentDelivered" || e.name === "ShipmentExpired");
  if (settled) {
    return { carrierPayout: BigInt(settled.args.carrierPayout), manufacturerRefund: BigInt(settled.args.manufacturerRefund) };
  }
  return { carrierPayout: BigInt(preview[0]), manufacturerRefund: BigInt(preview[1]) };
}
