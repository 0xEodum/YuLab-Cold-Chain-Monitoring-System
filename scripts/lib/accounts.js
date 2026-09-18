import { HDNodeWallet, Wallet } from "ethers";

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

/** Sensor wallet from SENSOR_PRIVATE_KEY, falling back to the demo key on local networks only. */
export function sensorWalletFromEnv(networkName) {
  const key = process.env.SENSOR_PRIVATE_KEY;
  if (key) return new Wallet(key);
  if (networkName === "hardhat" || networkName === "localhost") return DEMO_SENSOR_WALLET;
  throw new Error(`SENSOR_PRIVATE_KEY is required on network "${networkName}"`);
}
