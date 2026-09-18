import hardhatMocha from "@nomicfoundation/hardhat-mocha";
import hardhatEthers from "@nomicfoundation/hardhat-ethers";
import hardhatEthersChaiMatchers from "@nomicfoundation/hardhat-ethers-chai-matchers";
import hardhatNetworkHelpers from "@nomicfoundation/hardhat-network-helpers";

/** @type {import("hardhat/config").HardhatUserConfig} */
export default {
  plugins: [hardhatMocha, hardhatEthers, hardhatEthersChaiMatchers, hardhatNetworkHelpers],
  solidity: {
    // Matches the solc version shipped in ghcr.io/argotorg/solc:stable
    version: "0.8.37",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
    },
  },
  networks: {
    // In-process simulated chain used by `hardhat test` and `hardhat run` by default
    hardhat: { type: "edr-simulated", chainType: "l1" },
    // Standalone `npx hardhat node` — this is what the frontend will connect to
    localhost: { type: "http", chainType: "l1", url: "http://127.0.0.1:8545" },
  },
};
