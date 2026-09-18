import { network } from "hardhat";
import { saveDeployment } from "./lib/deployment.js";

const { ethers, networkName } = await network.getOrCreate();

const [deployer] = await ethers.getSigners();
const { chainId } = await ethers.provider.getNetwork();

console.log(`Deploying ColdChain to "${networkName}" (chainId ${chainId}) from ${deployer.address}`);

const coldChain = await ethers.deployContract("ColdChain", [], deployer);
const receipt = await coldChain.deploymentTransaction().wait();

const record = await saveDeployment(networkName, {
  address: coldChain.target,
  chainId,
  deployer: deployer.address,
  txHash: receipt.hash,
  abi: JSON.parse(coldChain.interface.formatJson()),
});

console.log(`ColdChain deployed at ${record.address} (block ${receipt.blockNumber})`);
console.log(`Deployment record written to deployments/${networkName}.json`);
