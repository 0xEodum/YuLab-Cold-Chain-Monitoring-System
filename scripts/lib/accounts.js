import { HDNodeWallet, Wallet, keccak256, toUtf8Bytes } from "ethers";

/**
 * Hardhat's well-known development mnemonic. Account #9 is reserved for the demo IoT sensor
 * so its key never collides with the manufacturer/carrier/receiver signers (#1..#3).
 * This is public test material, NOT a secret — never use it outside a local dev chain.
 */
const HARDHAT_MNEMONIC = "test test test test test test test test test test test junk";
const DEMO_SENSOR_ACCOUNT_INDEX = 9;

export const DEMO_SENSOR_WALLET = HDNodeWallet.fromPhrase(
  HARDHAT_MNEMONIC,
  undefined,
  `m/44'/60'/0'/0/${DEMO_SENSOR_ACCOUNT_INDEX}`,
);

/** Off-chain identity of the demo device; only its hash goes on-chain (see `registerSensor`). */
export const DEMO_DEVICE_ID = "COLD-SENSOR-001 / Vaisala-TMP-4 / cal-2026-03-11";
export const DEMO_DEVICE_ID_HASH = keccak256(toUtf8Bytes(DEMO_DEVICE_ID));

/**
 * Register the demo sensor if it is not on the registry yet, so the scripts and the frontend
 * work against a freshly deployed contract without a manual step.
 * @param coldChain contract connected to a signer holding SENSOR_REGISTRAR rights
 */
export async function ensureDemoSensorRegistered(coldChain, sensorAddress = DEMO_SENSOR_WALLET.address) {
  const { registeredAt, active } = await coldChain.getSensor(sensorAddress);
  if (registeredAt === 0n) {
    await (await coldChain.registerSensor(sensorAddress, DEMO_DEVICE_ID_HASH)).wait();
    return "registered";
  }
  if (!active) {
    await (await coldChain.setSensorActive(sensorAddress, true)).wait();
    return "reactivated";
  }
  return "already-active";
}

/** Sensor wallet from SENSOR_PRIVATE_KEY, falling back to the demo key on local networks only. */
export function sensorWalletFromEnv(networkName) {
  const key = process.env.SENSOR_PRIVATE_KEY;
  if (key) return new Wallet(key);
  if (networkName === "hardhat" || networkName === "localhost") return DEMO_SENSOR_WALLET;
  throw new Error(`SENSOR_PRIVATE_KEY is required on network "${networkName}"`);
}
