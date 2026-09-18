import { HDNodeWallet } from "ethers";

/**
 * Demo identities. All keys derive from Hardhat's public development mnemonic, so this is
 * usable ONLY against a local node — the same convention as scripts/lib/accounts.js:
 * #1 manufacturer, #2 carrier, #3 receiver, #9 sensor.
 */
const HARDHAT_MNEMONIC = "test test test test test test test test test test test junk";

export const ROLE_DEFS = Object.freeze([
  { id: "manufacturer", label: "Производитель", accountIndex: 1 },
  { id: "carrier", label: "Перевозчик", accountIndex: 2 },
  { id: "receiver", label: "Получатель", accountIndex: 3 },
]);

export const SENSOR_ACCOUNT_INDEX = 9;

export function walletForAccount(index) {
  return HDNodeWallet.fromPhrase(HARDHAT_MNEMONIC, undefined, `m/44'/60'/0'/0/${index}`);
}

/** Role objects with their wallets (unconnected; call `.connect(provider)` to sign). */
export const ROLES = Object.freeze(
  ROLE_DEFS.map((def) => Object.freeze({ ...def, wallet: walletForAccount(def.accountIndex) })),
);

export const SENSOR_WALLET = walletForAccount(SENSOR_ACCOUNT_INDEX);

export function roleById(id) {
  const role = ROLES.find((r) => r.id === id);
  if (!role) throw new Error(`Unknown role "${id}"`);
  return role;
}

/** Which of the demo identities an address belongs to (for labelling addresses in the UI). */
export function roleForAddress(address) {
  if (!address) return undefined;
  const lower = address.toLowerCase();
  if (lower === SENSOR_WALLET.address.toLowerCase()) return { id: "sensor", label: "Датчик" };
  return ROLES.find((r) => r.wallet.address.toLowerCase() === lower);
}
