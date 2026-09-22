import { useEffect, useState } from "react";
import { toBeHex, zeroPadValue } from "ethers";
import { CONTRACT_ADDRESS, coldChainInterface, resolveSettlement, toAnchor, toEvent, toReading, toShipment, toViolation } from "../lib/chain.js";

/** All shipments, newest first. Re-read on every block. */
export function useShipmentList(contract, blockNumber, enabled) {
  const [shipments, setShipments] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;

    (async () => {
      try {
        const count = Number(await contract.shipmentCount());
        const ids = Array.from({ length: count }, (_, i) => count - i);
        const raws = await Promise.all(ids.map((id) => contract.getShipment(id)));
        if (!cancelled) {
          setShipments(raws.map((raw, i) => toShipment(ids[i], raw)));
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [contract, blockNumber, enabled]);

  return { shipments, error };
}

/** Everything the UI shows about one shipment: storage views + full event history from logs. */
export function useShipment(contract, provider, shipmentId, blockNumber, enabled) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!enabled || !shipmentId) {
      setData(null);
      return undefined;
    }
    let cancelled = false;

    (async () => {
      try {
        const [rawShipment, rawViolations, rawAnchors, settlement, expiredPreview, logs, latestBlock] = await Promise.all([
          contract.getShipment(shipmentId),
          contract.getViolations(shipmentId),
          contract.getAnchors(shipmentId),
          contract.previewSettlement(shipmentId),
          contract.previewExpiredSettlement(shipmentId),
          provider.getLogs({
            address: CONTRACT_ADDRESS,
            fromBlock: 0,
            toBlock: "latest",
            // every shipment-scoped event has `shipmentId` as its first indexed topic
            topics: [null, zeroPadValue(toBeHex(shipmentId), 32)],
          }),
          provider.getBlock("latest"),
        ]);
        const parsed = logs
          .map((log) => {
            const fragment = coldChainInterface.parseLog(log);
            return fragment ? { ...log, args: fragment.args, fragment: fragment.fragment } : null;
          })
          .filter(Boolean);
        const events = parsed.map(toEvent);
        const readings = parsed.filter((l) => l.fragment.name === "ReadingSubmitted").map(toReading);

        if (!cancelled) {
          setData({
            shipment: toShipment(shipmentId, rawShipment),
            violations: rawViolations.map(toViolation),
            anchors: rawAnchors.map(toAnchor),
            settlement: resolveSettlement(settlement, events),
            expiredSettlement: { carrierPayout: BigInt(expiredPreview[0]), manufacturerRefund: BigInt(expiredPreview[1]) },
            readings,
            events,
            chainNow: latestBlock.timestamp,
          });
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [contract, provider, shipmentId, blockNumber, enabled]);

  return { data, error };
}

/** ETH balance + pull-payment credit for each demo role. */
export function useBalances(contract, provider, roles, blockNumber, enabled) {
  const [balances, setBalances] = useState({});

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;

    (async () => {
      try {
        const entries = await Promise.all(
          roles.map(async (role) => {
            const address = role.wallet.address;
            const [eth, pending] = await Promise.all([provider.getBalance(address), contract.pendingWithdrawals(address)]);
            return [role.id, { eth, pending: BigInt(pending) }];
          }),
        );
        if (!cancelled) setBalances(Object.fromEntries(entries));
      } catch {
        // balances are decorative; the shipment views surface connection errors
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [contract, provider, roles, blockNumber, enabled]);

  return balances;
}
