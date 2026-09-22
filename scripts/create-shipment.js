/**
 * Create a shipment (and optionally let the carrier accept it) on a deployed ColdChain.
 * Handy for preparing data for the gateway emulator or the frontend without a UI.
 *
 *   npx hardhat run scripts/create-shipment.js --network localhost
 *
 * Environment (all optional):
 *   PRODUCT        label, default "Vaccine Batch A17"
 *   MIN_C / MAX_C  allowed range in °C, default 2 / 8
 *   PAYMENT_ETH    escrowed payment, default 1
 *   PENALTY_BPS    penalty on violation in basis points, default 2000 (20%)
 *   START          "1" to also call startTransit as the carrier (default 1)
 *   Accounts: manufacturer = #1, carrier = #2, receiver = #3, sensor = SENSOR_PRIVATE_KEY or demo key
 */
import { network } from "hardhat";
import { toDeci } from "./lib/sensor.js";
import { loadDeployment } from "./lib/deployment.js";
import { ensureDemoSensorRegistered, sensorWalletFromEnv } from "./lib/accounts.js";

const { ethers, networkName } = await network.getOrCreate();

const product = process.env.PRODUCT ?? "Vaccine Batch A17";
const minC = Number(process.env.MIN_C ?? 2);
const maxC = Number(process.env.MAX_C ?? 8);
const paymentEth = process.env.PAYMENT_ETH ?? "1";
const penaltyBps = Number(process.env.PENALTY_BPS ?? 2000);
const shouldStart = (process.env.START ?? "1") === "1";
if (!(minC < maxC)) throw new Error(`MIN_C (${minC}) must be lower than MAX_C (${maxC})`);

const { address, abi } = await loadDeployment(networkName);
const [, manufacturer, carrier, receiver] = await ethers.getSigners();
const sensor = sensorWalletFromEnv(networkName);
const coldChain = new ethers.Contract(address, abi, manufacturer);

// A shipment may only be assigned to a registered sensor; put it on the registry if needed.
const [registrar] = await ethers.getSigners();
const registration = await ensureDemoSensorRegistered(coldChain.connect(registrar), sensor.address);
if (registration !== "already-active") console.log(`Sensor ${sensor.address} ${registration}`);

const tx = await coldChain.createShipment(product, carrier.address, receiver.address, sensor.address, toDeci(minC), toDeci(maxC), penaltyBps, {
  value: ethers.parseEther(paymentEth),
});
const receipt = await tx.wait();
const { shipmentId } = coldChain.interface.parseLog(receipt.logs.find((l) => l.address === address)).args;
console.log(`Created shipment #${shipmentId} "${product}" ${minC}°C..${maxC}°C, escrow ${paymentEth} ETH, penalty ${penaltyBps / 100}%`);
console.log(`  manufacturer ${manufacturer.address}\n  carrier      ${carrier.address}\n  receiver     ${receiver.address}\n  sensor       ${sensor.address}`);

if (shouldStart) {
  await (await coldChain.connect(carrier).startTransit(shipmentId)).wait();
  console.log(`Carrier accepted → IN_TRANSIT. Start the gateway with: SHIPMENT_ID=${shipmentId} npm run gateway`);
}
