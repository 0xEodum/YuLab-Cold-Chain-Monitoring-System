import { useEffect, useMemo, useState } from "react";
import { createProvider, probeChain, readContract } from "../lib/chain.js";

const POLL_MS = 1000;

/**
 * One provider + read-only contract for the whole app, plus the latest block number.
 * Everything else re-reads when `blockNumber` changes: on a Hardhat node a new block
 * means a transaction was mined, so this is the cheapest "something changed" signal.
 *
 * Block numbers are polled by hand rather than via `provider.on("block")`: ethers v6 does not
 * resume its polling subscriber after off()/on(), which StrictMode's double effect triggers.
 */
export function useChain() {
  const provider = useMemo(() => createProvider(), []);
  const contract = useMemo(() => readContract(provider), [provider]);
  const [blockNumber, setBlockNumber] = useState(0);
  const [health, setHealth] = useState({ state: "connecting" });

  useEffect(() => {
    let cancelled = false;
    let lastBlock = -1;
    let lastHealthy = false;
    let inFlight = false;

    async function tick() {
      // a slow RPC round-trip must not let two ticks interleave and apply stale results
      if (inFlight) return;
      inFlight = true;
      try {
        const n = await provider.getBlockNumber();
        if (cancelled) return;
        // Re-probe on every new block so the banner clears as soon as the contract appears
        // after a redeploy, and after the node comes back.
        if (n !== lastBlock || !lastHealthy) {
          const result = await probeChain(provider);
          if (cancelled) return;
          setHealth({ state: "ok", ...result });
          lastHealthy = result.chainMatches && result.contractDeployed;
        }
        if (n !== lastBlock) {
          lastBlock = n;
          setBlockNumber(n);
        }
      } catch (err) {
        if (cancelled) return;
        lastHealthy = false;
        setHealth({ state: "error", error: err });
      } finally {
        inFlight = false;
      }
    }

    tick();
    const timer = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [provider]);

  return { provider, contract, blockNumber, health };
}
