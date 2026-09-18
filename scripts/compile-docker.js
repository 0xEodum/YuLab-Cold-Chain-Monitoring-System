/**
 * Alternative build using the containerised compiler (ghcr.io/argotorg/solc:stable).
 * Produces ABI + bytecode in build-solc/ with the same settings Hardhat uses
 * (optimizer on, via-IR), so both toolchains can be cross-checked.
 *
 *   npm run compile:docker
 */
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";

const IMAGE = process.env.SOLC_IMAGE ?? "ghcr.io/argotorg/solc:stable";
const OUT_DIR = "build-solc";

mkdirSync(OUT_DIR, { recursive: true });

const args = [
  "run", "--rm",
  "-v", `${process.cwd()}:/src`,
  "-w", "/src",
  IMAGE,
  "--base-path", ".",
  "--include-path", "node_modules",
  "--optimize", "--optimize-runs", "200",
  "--via-ir",
  "--abi", "--bin",
  "--overwrite",
  "-o", OUT_DIR,
  "contracts/ColdChain.sol",
];

console.log(`docker ${args.join(" ")}`);
const result = spawnSync("docker", args, { stdio: "inherit" });
if (result.error) {
  console.error(`Failed to start docker: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
