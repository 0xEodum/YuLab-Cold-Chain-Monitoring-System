import { describe, expect, test } from "vitest";
import { Interface, Wallet, getBytes, hashMessage, recoverAddress } from "ethers";
import { ROLES, SENSOR_WALLET, roleById, roleForAddress, walletForAccount } from "./roles.js";
import { formatBps, formatDuration, formatEth, formatTemp, isActiveStatus, isTerminalStatus, statusMeta, toDeci } from "./format.js";
import { decodeContractError, describeError } from "./errors.js";
import {
  buildMeasurement,
  canonicalJson,
  nextTimestamp,
  readingDigest,
  signReading,
  telemetryRecordHash,
  temperatureAt,
  verifyTelemetry,
} from "./sensor.js";
import { CONTRACT_ABI, coldChainInterface, resolveSettlement, toEvent, toReading, toShipment } from "./chain.js";

describe("roles", () => {
  test("derives the well-known Hardhat accounts", () => {
    // Hardhat account #1 and #2 from the public dev mnemonic
    expect(roleById("manufacturer").wallet.address).toBe("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
    expect(roleById("carrier").wallet.address).toBe("0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC");
    expect(walletForAccount(0).address).toBe("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
  });

  test("labels known addresses and ignores unknown ones", () => {
    expect(roleForAddress(ROLES[2].wallet.address.toLowerCase()).id).toBe("receiver");
    expect(roleForAddress(SENSOR_WALLET.address).id).toBe("sensor");
    expect(roleForAddress("0x0000000000000000000000000000000000000001")).toBeUndefined();
    expect(roleForAddress(undefined)).toBeUndefined();
  });

  test("throws on unknown role id", () => {
    expect(() => roleById("auditor")).toThrow(/Unknown role/);
  });
});

describe("format", () => {
  test("temperature conversions round-trip in tenths of a degree", () => {
    expect(toDeci(2)).toBe(20);
    expect(toDeci("12.7")).toBe(127);
    expect(toDeci(-0.55)).toBe(-5);
    expect(formatTemp(127)).toBe("12.7 °C");
    expect(formatTemp(-30n)).toBe("-3.0 °C");
  });

  test("formats ETH, bps and durations", () => {
    expect(formatEth(1_000_000_000_000_000_000n)).toBe("1 ETH");
    expect(formatEth(800_000_000_000_000_000n)).toBe("0.8 ETH");
    expect(formatEth(0n)).toBe("0 ETH");
    expect(formatBps(2000)).toBe("20 %");
    expect(formatBps(1250)).toBe("12.50 %");
    expect(formatDuration(30 * 86_400)).toBe("30 д 0 ч");
    expect(formatDuration(3 * 3600 + 120)).toBe("3 ч 2 мин");
    expect(formatDuration(59)).toBe("0 мин");
  });

  test("status helpers", () => {
    expect(statusMeta(2).name).toBe("COMPROMISED");
    expect(statusMeta(99).label).toBe("?");
    expect(isActiveStatus(1n)).toBe(true);
    expect(isActiveStatus(3)).toBe(false);
    expect(isTerminalStatus(5)).toBe(true);
    expect(isTerminalStatus(0)).toBe(false);
  });
});

describe("errors", () => {
  const iface = new Interface(CONTRACT_ABI);

  test("decodes custom errors from revert data in any ethers error shape", () => {
    const data = iface.encodeErrorResult("SequenceMismatch", [3, 5]);
    expect(describeError(iface, { data }).message).toMatch(/ожидалось показание #3, получено #5/);
    expect(describeError(iface, { info: { error: { data } } }).code).toBe("SequenceMismatch");
    expect(describeError(iface, { error: { data } }).code).toBe("SequenceMismatch");
  });

  test("explains InvalidStatus with the status name", () => {
    const data = iface.encodeErrorResult("InvalidStatus", [1, 3]);
    expect(describeError(iface, { data }).message).toContain("DELIVERED");
  });

  test("falls back for unknown / non-contract errors", () => {
    expect(decodeContractError(iface, { data: "0xdeadbeef" })).toBeUndefined();
    expect(decodeContractError(iface, { data: 42 })).toBeUndefined();
    expect(describeError(iface, { code: "INSUFFICIENT_FUNDS" }).message).toMatch(/Недостаточно ETH/);
    expect(describeError(iface, new TypeError("fetch failed")).code).toBe("NETWORK");
    expect(describeError(iface, { shortMessage: "boom" }).message).toBe("boom");
    expect(describeError(undefined, new Error("x")).message).toBe("x");
  });
});

describe("sensor", () => {
  test("nextTimestamp is monotonic and never behind chain time or transit start", () => {
    expect(nextTimestamp({ now: 100, chainNow: 90, lastReadingAt: 50, startedAt: 10 })).toBe(100);
    expect(nextTimestamp({ now: 100, chainNow: 500, lastReadingAt: 50, startedAt: 10 })).toBe(500);
    expect(nextTimestamp({ now: 100, chainNow: 90, lastReadingAt: 100n, startedAt: 10 })).toBe(101);
    expect(nextTimestamp({ now: 100, chainNow: 0, lastReadingAt: 0, startedAt: 700 })).toBe(700);
  });

  test("spike profile injects an excursion only at the configured indices", () => {
    const random = () => 0.5; // no jitter
    expect(temperatureAt(0, { profile: "spike", random })).toBeCloseTo(4.5);
    expect(temperatureAt(4, { profile: "spike", random })).toBeCloseTo(12.7);
    expect(temperatureAt(5, { profile: "spike", random })).toBeCloseTo(12.7);
    expect(temperatureAt(6, { profile: "spike", random })).toBeCloseTo(4.5);
    expect(temperatureAt(4, { profile: "normal", random, baseTempC: 3 })).toBeCloseTo(3);
  });

  test("signature recovers to the sensor address over the contract digest", async () => {
    const sensor = Wallet.createRandom();
    const contractAddress = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
    const { record, telemetryHash } = buildMeasurement({
      shipmentId: 1,
      sequence: 0,
      temperature: 45,
      timestamp: 1_700_000_000,
      deviceId: "COLD-SENSOR-001",
    });
    const reading = { chainId: 31337n, contractAddress, shipmentId: 1, sequence: 0, temperature: 45, timestamp: 1_700_000_000, telemetryHash };

    const signature = await signReading(sensor, reading);
    expect(recoverAddress(hashMessage(getBytes(readingDigest(reading))), signature)).toBe(sensor.address);

    // altering the temperature after signing breaks recovery — the property the UI demonstrates
    const altered = readingDigest({ ...reading, temperature: 52 });
    expect(recoverAddress(hashMessage(getBytes(altered)), signature)).not.toBe(sensor.address);

    // ...and so does pointing the same reading at a different off-chain record
    const swapped = readingDigest({ ...reading, telemetryHash: telemetryRecordHash({ ...record, temperature: 52 }) });
    expect(recoverAddress(hashMessage(getBytes(swapped)), signature)).not.toBe(sensor.address);
  });

  test("canonicalJson is independent of key order, so equal records hash equally", () => {
    const a = { shipmentId: "1", sequence: 0, temperature: 45, measuredAt: 10, deviceId: "d" };
    const b = { deviceId: "d", measuredAt: 10, temperature: 45, sequence: 0, shipmentId: "1" };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(telemetryRecordHash(a)).toBe(telemetryRecordHash(b));
  });

  test("verifyTelemetry flags edited, missing and uncommitted records", () => {
    const build = (sequence, temperature) =>
      buildMeasurement({ shipmentId: 1, sequence, temperature, timestamp: 100 + sequence, deviceId: "d" });
    const [zero, one, two] = [build(0, 45), build(1, 127), build(2, 50)];
    const readings = [zero, one].map((m, i) => ({ sequence: i, telemetryHash: m.telemetryHash }));

    expect(verifyTelemetry([zero.record, one.record], readings).ok).toBe(true);

    // record #1 edited off-chain, record #0 deleted, record #2 never committed on-chain
    const doctored = [{ ...one.record, temperature: 45 }, two.record];
    const { ok, results } = verifyTelemetry(doctored, readings);
    expect(ok).toBe(false);
    expect(results.map((r) => r.status)).toEqual(["missing", "tampered", "unanchored"]);
  });
});

describe("chain mappers", () => {
  test("toShipment normalises bigint fields", () => {
    const raw = {
      manufacturer: "0xa",
      carrier: "0xb",
      receiver: "0xc",
      sensor: "0xd",
      minTemp: 20n,
      maxTemp: 80n,
      penaltyBps: 2000n,
      status: 2n,
      createdAt: 1n,
      startedAt: 2n,
      deliveredAt: 0n,
      lastReadingAt: 3n,
      readingCount: 4n,
      violationCount: 1n,
      payment: 10n ** 18n,
      product: "Vaccine",
    };
    const s = toShipment(7n, raw);
    expect(s).toMatchObject({ id: 7, minTemp: 20, maxTemp: 80, status: 2, readingCount: 4, product: "Vaccine" });
    expect(s.payment).toBe(10n ** 18n);
  });

  test("toReading / toEvent read parsed logs", () => {
    const fragment = coldChainInterface.getEvent("ReadingSubmitted");
    const telemetryHash = `0x${"cd".repeat(32)}`;
    const encoded = coldChainInterface.encodeEventLog(fragment, [1, 3, 127, 1_700_000_000, telemetryHash, ROLES[1].wallet.address, false]);
    const parsed = coldChainInterface.parseLog({ topics: encoded.topics, data: encoded.data });
    const log = { args: parsed.args, fragment: parsed.fragment, blockNumber: 12, transactionHash: "0xabc", index: 0 };
    expect(toReading(log)).toMatchObject({ sequence: 3, temperature: 127, telemetryHash, inRange: false, blockNumber: 12, txHash: "0xabc" });
    const ev = toEvent(log);
    expect(ev.name).toBe("ReadingSubmitted");
    expect(ev.args.temperature).toBe("127");
  });

  test("resolveSettlement prefers the settlement event over the live preview", () => {
    const preview = [10n ** 18n, 0n];
    expect(resolveSettlement(preview, [])).toEqual({ carrierPayout: 10n ** 18n, manufacturerRefund: 0n });
    const events = [{ name: "ShipmentDelivered", args: { carrierPayout: "800", manufacturerRefund: "200" } }];
    expect(resolveSettlement(preview, events)).toEqual({ carrierPayout: 800n, manufacturerRefund: 200n });
  });
});
