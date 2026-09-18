import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { availableActions, ActionsPanel } from "./ActionsPanel.jsx";
import { validateForm, CreateShipmentForm } from "./CreateShipmentForm.jsx";
import { chartLayout, TemperatureChart } from "./TemperatureChart.jsx";
import { telemetryWarning } from "./ShipmentDetails.jsx";
import { TxStatus } from "./TxStatus.jsx";
import { ShipmentList } from "./ShipmentList.jsx";
import { EventLog } from "./EventLog.jsx";
import { ReadingsTable } from "./ReadingsTable.jsx";
import { ROLES } from "../lib/roles.js";

const DAY = 86_400;

function shipment(overrides = {}) {
  return {
    id: 1,
    product: "Vaccine",
    manufacturer: ROLES[0].wallet.address,
    carrier: ROLES[1].wallet.address,
    receiver: ROLES[2].wallet.address,
    sensor: "0x0000000000000000000000000000000000000009",
    minTemp: 20,
    maxTemp: 80,
    penaltyBps: 2000,
    status: 1,
    createdAt: 1000,
    startedAt: 2000,
    deliveredAt: 0,
    lastReadingAt: 0,
    readingCount: 0,
    violationCount: 0,
    payment: 10n ** 18n,
    ...overrides,
  };
}

describe("availableActions mirrors the contract's access rules", () => {
  test("CREATED: carrier may start, manufacturer may cancel, receiver has nothing", () => {
    const s = shipment({ status: 0 });
    expect(availableActions(s, "carrier", 2000).map((a) => a.id)).toEqual(["startTransit"]);
    expect(availableActions(s, "manufacturer", 2000).map((a) => a.id)).toEqual(["cancelShipment"]);
    expect(availableActions(s, "receiver", 2000)).toEqual([]);
  });

  test("IN_TRANSIT: receiver confirms; settleExpired is locked for 30 days", () => {
    const s = shipment({ status: 1, startedAt: 2000 });
    expect(availableActions(s, "receiver", 3000).map((a) => a.id)).toEqual(["confirmDelivery"]);
    const [settle] = availableActions(s, "carrier", 3000);
    expect(settle.id).toBe("settleExpired");
    expect(settle.disabled).toBe(true);
    expect(availableActions(s, "manufacturer", 2000 + 30 * DAY)[0].disabled).toBe(false);
  });

  test("terminal statuses offer nothing", () => {
    for (const status of [3, 4, 5]) {
      for (const role of ["manufacturer", "carrier", "receiver"]) {
        expect(availableActions(shipment({ status }), role, 10 ** 9)).toEqual([]);
      }
    }
  });

  test("ActionsPanel renders buttons and calls onAction", () => {
    const onAction = vi.fn();
    render(<ActionsPanel shipment={shipment({ status: 0 })} roleId="carrier" roleLabel="Перевозчик" chainNow={0} onAction={onAction} isPending={false} />);
    fireEvent.click(screen.getByRole("button", { name: /Принять и начать/ }));
    expect(onAction).toHaveBeenCalledWith("startTransit", expect.any(String));
  });

  test("ActionsPanel explains when nothing is available", () => {
    render(<ActionsPanel shipment={shipment({ status: 3 })} roleId="receiver" roleLabel="Получатель" chainNow={0} onAction={() => {}} isPending={false} />);
    expect(screen.getByText(/действий нет/)).toBeInTheDocument();
  });
});

describe("telemetryWarning", () => {
  test("warns when no readings were ever submitted while active or settled", () => {
    expect(telemetryWarning(shipment({ status: 1, readingCount: 0 }), 5000)).toMatch(/отсутствует/);
    expect(telemetryWarning(shipment({ status: 3, readingCount: 0, deliveredAt: 9000 }), 5000)).toMatch(/отсутствует/);
  });

  test("warns when the stream stopped long before now / delivery", () => {
    expect(telemetryWarning(shipment({ status: 1, readingCount: 5, lastReadingAt: 1000 }), 1000 + 3600)).toMatch(/оборвана/);
    expect(telemetryWarning(shipment({ status: 3, readingCount: 5, lastReadingAt: 1000, deliveredAt: 1000 + 2 * 3600 }), 0)).toMatch(/оборвана/);
  });

  test("is quiet for fresh telemetry and for CREATED / CANCELLED", () => {
    expect(telemetryWarning(shipment({ status: 2, readingCount: 5, lastReadingAt: 1000 }), 1100)).toBeNull();
    expect(telemetryWarning(shipment({ status: 0 }), 5000)).toBeNull();
    expect(telemetryWarning(shipment({ status: 4 }), 5000)).toBeNull();
  });
});

describe("CreateShipmentForm", () => {
  test("validateForm mirrors contract checks", () => {
    const ok = { product: "X", minC: "2", maxC: "8", paymentEth: "1", penaltyPct: "20" };
    expect(validateForm(ok)).toBeNull();
    expect(validateForm({ ...ok, product: "  " })).toMatch(/название/);
    expect(validateForm({ ...ok, minC: "8", maxC: "2" })).toMatch(/ниже максимальной/);
    expect(validateForm({ ...ok, paymentEth: "0" })).toMatch(/больше нуля/);
    expect(validateForm({ ...ok, penaltyPct: "150" })).toMatch(/0 до 100/);
    expect(validateForm({ ...ok, minC: "abc" })).toMatch(/числами/);
  });

  test("submits contract-ready params", () => {
    const onSubmit = vi.fn();
    render(<CreateShipmentForm onSubmit={onSubmit} isPending={false} />);
    fireEvent.submit(screen.getByRole("button", { name: /Создать/ }).closest("form"));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const params = onSubmit.mock.calls[0][0];
    expect(params).toMatchObject({ product: "Vaccine Batch A17", minTemp: 20, maxTemp: 80, penaltyBps: 2000, carrier: ROLES[1].wallet.address });
    expect(params.value).toBe(10n ** 18n);
  });

  test("shows validation instead of submitting", () => {
    const onSubmit = vi.fn();
    render(<CreateShipmentForm onSubmit={onSubmit} isPending={false} />);
    fireEvent.change(screen.getByLabelText(/Мин/), { target: { value: "10" } });
    fireEvent.submit(screen.getByRole("button", { name: /Создать/ }).closest("form"));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText(/ниже максимальной/)).toBeInTheDocument();
  });
});

describe("TemperatureChart", () => {
  const readings = [
    { sequence: 0, temperature: 45, timestamp: 100, inRange: true, blockNumber: 1, txHash: "0x1" },
    { sequence: 1, temperature: 127, timestamp: 200, inRange: false, blockNumber: 2, txHash: "0x2" },
    { sequence: 2, temperature: 50, timestamp: 300, inRange: true, blockNumber: 3, txHash: "0x3" },
  ];

  test("layout keeps the allowed band and all points inside the plot", () => {
    const { points, lo, hi } = chartLayout(readings, 20, 80);
    expect(lo).toBeLessThan(20);
    expect(hi).toBeGreaterThan(127);
    expect(points[0].cx).toBeLessThan(points[2].cx);
    expect(points[1].cy).toBeLessThan(points[0].cy); // hotter is higher on screen
  });

  test("renders empty state and violation markers", () => {
    const { rerender } = render(<TemperatureChart readings={[]} minTemp={20} maxTemp={80} />);
    expect(screen.getByText(/Показаний пока нет/)).toBeInTheDocument();
    rerender(<TemperatureChart readings={readings} minTemp={20} maxTemp={80} />);
    expect(document.querySelectorAll(".chart-dot-violation")).toHaveLength(1);
    expect(screen.getByRole("img").getAttribute("aria-label")).toMatch(/3 показаниям/);
  });

  test("ReadingsTable highlights violations and limits rows", () => {
    render(<ReadingsTable readings={readings} limit={2} />);
    expect(document.querySelectorAll(".row-violation")).toHaveLength(1);
    expect(screen.getByText(/последние 2 из 3/)).toBeInTheDocument();
  });
});

describe("TxStatus / ShipmentList / EventLog", () => {
  test("TxStatus renders each lifecycle state", () => {
    const { rerender } = render(<TxStatus state={{ status: "idle" }} onDismiss={() => {}} />);
    expect(document.body.textContent).toBe("");
    rerender(<TxStatus state={{ status: "pending", label: "X" }} onDismiss={() => {}} />);
    expect(screen.getByText(/ждём блок/)).toBeInTheDocument();
    rerender(<TxStatus state={{ status: "success", label: "X", txHash: "0x" + "ab".repeat(32), blockNumber: 5 }} onDismiss={() => {}} />);
    expect(screen.getByText(/блоке #5/)).toBeInTheDocument();
    const onDismiss = vi.fn();
    rerender(<TxStatus state={{ status: "error", label: "X", error: { code: "InvalidSignature", message: "bad" } }} onDismiss={onDismiss} />);
    expect(screen.getByText("InvalidSignature")).toBeInTheDocument();
    fireEvent.click(screen.getByText("скрыть"));
    expect(onDismiss).toHaveBeenCalled();
  });

  test("ShipmentList selects on click and shows empty hint", () => {
    const onSelect = vi.fn();
    const { rerender } = render(<ShipmentList shipments={[]} selectedId={null} onSelect={onSelect} />);
    expect(screen.getByText(/Поставок пока нет/)).toBeInTheDocument();
    rerender(<ShipmentList shipments={[shipment({ violationCount: 2 })]} selectedId={null} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button"));
    expect(onSelect).toHaveBeenCalledWith(1);
    expect(screen.getByText(/нарушений: 2/)).toBeInTheDocument();
  });

  test("EventLog describes events newest first", () => {
    const events = [
      { name: "ShipmentCreated", args: { product: "V", minTemp: "20", maxTemp: "80", payment: "1000000000000000000", penaltyBps: "2000" }, blockNumber: 1, txHash: "0x1", logIndex: 0 },
      { name: "TemperatureViolation", args: { temperature: "127", timestamp: "100", violationIndex: "0" }, blockNumber: 2, txHash: "0x2", logIndex: 0 },
      { name: "Unknown", args: { a: "1" }, blockNumber: 3, txHash: "0x3", logIndex: 0 },
    ];
    render(<EventLog events={events} />);
    const items = screen.getAllByRole("listitem");
    expect(items[0].textContent).toContain("Unknown");
    expect(items[1].textContent).toContain("Нарушение №1: 12.7 °C");
    expect(items[2].textContent).toContain("escrow 1 ETH");
  });
});
