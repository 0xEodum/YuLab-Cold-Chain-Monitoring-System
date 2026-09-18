import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useTransaction } from "./useTransaction.js";
import { useBalances, useShipment, useShipmentList } from "./useShipments.js";
import { useChain } from "./useChain.js";
import { CONTRACT_ADDRESS, coldChainInterface } from "../lib/chain.js";
import { ROLES } from "../lib/roles.js";

vi.mock("../lib/chain.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, createProvider: () => fakeProvider, readContract: () => fakeContract };
});

const RAW_SHIPMENT = {
  manufacturer: ROLES[0].wallet.address,
  carrier: ROLES[1].wallet.address,
  receiver: ROLES[2].wallet.address,
  sensor: "0x0000000000000000000000000000000000000009",
  minTemp: 20n,
  maxTemp: 80n,
  penaltyBps: 2000n,
  status: 2n,
  createdAt: 1n,
  startedAt: 2n,
  deliveredAt: 0n,
  lastReadingAt: 3n,
  readingCount: 1n,
  violationCount: 1n,
  payment: 10n ** 18n,
  product: "Vaccine",
};

function encodedLog(name, args, blockNumber) {
  const fragment = coldChainInterface.getEvent(name);
  const { topics, data } = coldChainInterface.encodeEventLog(fragment, args);
  return { address: CONTRACT_ADDRESS, topics, data, blockNumber, transactionHash: `0x${String(blockNumber).padStart(64, "0")}`, index: 0 };
}

const fakeContract = {
  shipmentCount: vi.fn(async () => 2n),
  getShipment: vi.fn(async () => RAW_SHIPMENT),
  getViolations: vi.fn(async () => [{ temperature: 127n, timestamp: 3n, recordedAt: 4n }]),
  getAnchors: vi.fn(async () => [{ dataHash: "0x" + "ab".repeat(32), fromTimestamp: 1n, toTimestamp: 3n, anchoredBy: ROLES[1].wallet.address, anchoredAt: 5n }]),
  previewSettlement: vi.fn(async () => [800n, 200n]),
  pendingWithdrawals: vi.fn(async () => 5n),
};

const fakeProvider = {
  getLogs: vi.fn(async () => [
    encodedLog("ReadingSubmitted", [1, 0, 127, 3, ROLES[1].wallet.address, false], 7),
    encodedLog("TemperatureViolation", [1, 127, 3, 0], 7),
  ]),
  getBlock: vi.fn(async () => ({ timestamp: 1000 })),
  getBalance: vi.fn(async () => 10n ** 18n),
  getBlockNumber: vi.fn(async () => 7),
  getNetwork: vi.fn(async () => ({ chainId: 31337n })),
  getCode: vi.fn(async () => "0x6080"),
};

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.useRealTimers());

describe("useTransaction", () => {
  test("tracks pending → success and returns the receipt", async () => {
    const { result } = renderHook(() => useTransaction());
    const receipt = { hash: "0xabc", blockNumber: 3 };
    let returned;
    await act(async () => {
      returned = await result.current.run("Тест", async () => ({ wait: async () => receipt }));
    });
    expect(returned).toBe(receipt);
    expect(result.current.state).toMatchObject({ status: "success", label: "Тест", txHash: "0xabc", blockNumber: 3 });
    act(() => result.current.reset());
    expect(result.current.state.status).toBe("idle");
  });

  test("decodes a contract revert into a readable error", async () => {
    const { result } = renderHook(() => useTransaction());
    const data = coldChainInterface.encodeErrorResult("Unauthorized", [ROLES[2].wallet.address]);
    await act(async () => {
      await result.current.run("Тест", async () => {
        throw { data };
      });
    });
    expect(result.current.state.status).toBe("error");
    expect(result.current.state.error.code).toBe("Unauthorized");
    expect(result.current.isPending).toBe(false);
  });
});

describe("useShipmentList", () => {
  test("loads shipments newest first when enabled", async () => {
    const { result } = renderHook(() => useShipmentList(fakeContract, 1, true));
    await waitFor(() => expect(result.current.shipments).toHaveLength(2));
    expect(result.current.shipments.map((s) => s.id)).toEqual([2, 1]);
    expect(result.current.shipments[0].product).toBe("Vaccine");
  });

  test("stays empty while disabled and reports errors", async () => {
    const { result, rerender } = renderHook(({ enabled }) => useShipmentList(fakeContract, 1, enabled), { initialProps: { enabled: false } });
    expect(result.current.shipments).toEqual([]);
    fakeContract.shipmentCount.mockRejectedValueOnce(new Error("rpc down"));
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.error?.message).toBe("rpc down"));
  });
});

describe("useShipment", () => {
  test("assembles storage views, readings and events for one shipment", async () => {
    const { result } = renderHook(() => useShipment(fakeContract, fakeProvider, 1, 1, true));
    await waitFor(() => expect(result.current.data).not.toBeNull());
    const { shipment, violations, anchors, settlement, readings, events, chainNow } = result.current.data;
    expect(shipment.id).toBe(1);
    expect(violations[0].temperature).toBe(127);
    expect(anchors).toHaveLength(1);
    expect(settlement).toEqual({ carrierPayout: 800n, manufacturerRefund: 200n });
    expect(readings).toEqual([expect.objectContaining({ sequence: 0, temperature: 127, inRange: false, blockNumber: 7 })]);
    expect(events.map((e) => e.name)).toEqual(["ReadingSubmitted", "TemperatureViolation"]);
    expect(chainNow).toBe(1000);
    expect(fakeProvider.getLogs).toHaveBeenCalledWith(expect.objectContaining({ address: CONTRACT_ADDRESS }));
  });

  test("clears data when no shipment is selected", async () => {
    const { result } = renderHook(() => useShipment(fakeContract, fakeProvider, null, 1, true));
    expect(result.current.data).toBeNull();
  });
});

describe("useBalances", () => {
  test("reads ETH balance and pending withdrawals per role", async () => {
    const { result } = renderHook(() => useBalances(fakeContract, fakeProvider, ROLES, 1, true));
    await waitFor(() => expect(Object.keys(result.current)).toHaveLength(3));
    expect(result.current.carrier).toEqual({ eth: 10n ** 18n, pending: 5n });
  });
});

describe("useChain", () => {
  test("polls the block number and probes the node", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useChain());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(result.current.blockNumber).toBe(7);
    expect(result.current.health).toMatchObject({ state: "ok", chainMatches: true, contractDeployed: true });

    fakeProvider.getBlockNumber.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(result.current.health.state).toBe("error");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(result.current.health.state).toBe("ok");
  });
});

describe("useChain in-flight guard", () => {
  test("does not start a second tick while one is still awaiting the node", async () => {
    vi.useFakeTimers();
    let release;
    fakeProvider.getBlockNumber.mockImplementationOnce(() => new Promise((r) => { release = r; }));
    renderHook(() => useChain());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(fakeProvider.getBlockNumber).toHaveBeenCalledTimes(1);
    await act(async () => {
      release(7);
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(fakeProvider.getBlockNumber).toHaveBeenCalledTimes(2);
  });
});
