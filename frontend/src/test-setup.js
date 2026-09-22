import "@testing-library/jest-dom/vitest";
import { configure } from "@testing-library/dom";

/**
 * The UI refreshes on the block poll in `useChain` (1 s), so anything that follows a transaction
 * becomes visible only on the next tick. The default 1000 ms async timeout races that interval
 * exactly; give the polling a couple of cycles instead.
 */
configure({ asyncUtilTimeout: 4000 });
