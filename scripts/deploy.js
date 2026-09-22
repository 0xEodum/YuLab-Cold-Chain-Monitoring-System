import { network } from "hardhat";
import { saveDeployment } from "./lib/deployment.js";
import { DEMO_SENSOR_WALLET, DEMO_DEVICE_ID, ensureDemoSensorRegistered } from "./lib/accounts.js";

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
console.log(`Admin / first sensor registrar: ${deployer.address}`);

// A shipment can only be assigned to a registered sensor, so put the demo device on the
// registry right away — otherwise nothing in the demo can create a shipment.
if (networkName === "hardhat" || networkName === "localhost") {
  const outcome = await ensureDemoSensorRegistered(coldChain);
  console.log(`Demo sensor ${DEMO_SENSOR_WALLET.address} ${outcome} ("${DEMO_DEVICE_ID}")`);
} else {
  console.log(`Register a sensor before creating shipments: coldChain.registerSensor(<sensor>, <deviceIdHash>)`);
}
