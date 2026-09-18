import { useCallback, useState } from "react";
import { coldChainInterface } from "../lib/chain.js";
import { describeError } from "../lib/errors.js";

/**
 * Runs a transaction-producing function, tracks its lifecycle and decodes contract reverts.
 * `run(label, fn)` — `fn` must return a ContractTransactionResponse; the receipt is awaited.
 */
export function useTransaction() {
  const [state, setState] = useState({ status: "idle" });

  const run = useCallback(async (label, fn) => {
    setState({ status: "pending", label });
    try {
      const tx = await fn();
      const receipt = await tx.wait();
      setState({ status: "success", label, txHash: receipt.hash, blockNumber: receipt.blockNumber, receipt });
      return receipt;
    } catch (err) {
      const described = describeError(coldChainInterface, err);
      setState({ status: "error", label, error: described });
      return undefined;
    }
  }, []);

  const reset = useCallback(() => setState({ status: "idle" }), []);

  return { state, run, reset, isPending: state.status === "pending" };
}
