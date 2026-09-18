import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const DEPLOYMENTS_DIR = path.resolve("deployments");

export function deploymentPath(networkName) {
  return path.join(DEPLOYMENTS_DIR, `${networkName}.json`);
}

/** Persist address + ABI so the frontend and scripts can find the contract. */
export async function saveDeployment(networkName, { address, chainId, abi, deployer, txHash }) {
  await mkdir(DEPLOYMENTS_DIR, { recursive: true });
  const record = { contract: "ColdChain", address, chainId: chainId.toString(), deployer, txHash, deployedAt: new Date().toISOString(), abi };
  await writeFile(deploymentPath(networkName), JSON.stringify(record, null, 2) + "\n");
  return record;
}

export async function loadDeployment(networkName) {
  try {
    return JSON.parse(await readFile(deploymentPath(networkName), "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") {
      throw new Error(`No deployment found for network "${networkName}". Run: npx hardhat run scripts/deploy.js --network ${networkName}`);
    }
    throw err;
  }
}
