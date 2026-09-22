import { beforeEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import App from "./App.jsx";
import { CONTRACT_ADDRESS, coldChainInterface } from "./lib/chain.js";
import { ROLES, SENSOR_WALLET } from "./lib/roles.js";

/**
 * In-memory stand-in for the node + contract: enough state to walk the demo scenario
 * (create → start → reading → violation → confirm) without an RPC.
 */
const chain = {
  block: 1,
  shipments: {},
  logs: [],
  pending: {},
  code: "0x6080",
};

function emit(name, args) {
  const fragment = coldChainInterface.getEvent(name);
  const { topics, data } = coldChainInterface.encodeEventLog(fragment, args);
  chain.logs.push({ address: CONTRACT_ADDRESS, topics, data, blockNumber: chain.block, transactionHash: `0x${String(chain.block).padStart(64, "0")}`, index: chain.logs.length });
}

function mine() {
  chain.block += 1;
  return { wait: async () => ({ hash: `0x${String(chain.block).padStart(64, "0")}`, blockNumber: chain.block, logs: [] }) };
}

function blankShipment(product, sender, value) {
  return {
    manufacturer: sender,
    carrier: ROLES[1].wallet.address,
    receiver: ROLES[2].wallet.address,
    sensor: SENSOR_WALLET.address,
    minTemp: 20n,
    maxTemp: 80n,
    penaltyBps: 2000n,
    status: 0n,
    createdAt: 100n,
    startedAt: 0n,
    deliveredAt: 0n,
    lastReadingAt: 0n,
    readingCount: 0n,
    violationCount: 0n,
    payment: value,
    product,
  };
}

const fakeProvider = {
  getBlockNumber: async () => chain.block,
  getNetwork: async () => ({ chainId: 31337n }),
  getCode: async () => chain.code,
  getBlock: async () => ({ timestamp: 1_000 }),
  getBalance: async () => 10n ** 21n,
  getLogs: async ({ topics }) => chain.logs.filter((l) => l.topics[1] === topics[1]),
};

function contractFor(signerAddress) {
  return {
    interface: coldChainInterface,
    shipmentCount: async () => BigInt(Object.keys(chain.shipments).length),
    getShipment: async (id) => chain.shipments[Number(id)],
    getViolations: async () => [],
    getAnchors: async () => [],
    previewSettlement: async (id) => {
      const s = chain.shipments[Number(id)];
      const refund = s.violationCount > 0n ? (s.payment * s.penaltyBps) / 10_000n : 0n;
      return [s.payment - refund, refund];
    },
    // settleExpired always withholds the penalty: nobody confirmed the delivery.
    previewExpiredSettlement: async (id) => {
      const s = chain.shipments[Number(id)];
      const refund = (s.payment * s.penaltyBps) / 10_000n;
      return [s.payment - refund, refund];
    },
    pendingWithdrawals: async (addr) => chain.pending[addr] ?? 0n,
    createShipment: async (product, carrier, receiver, sensor, minTemp, maxTemp, penaltyBps, { value }) => {
      const id = Object.keys(chain.shipments).length + 1;
      chain.shipments[id] = blankShipment(product, signerAddress, value);
      const tx = mine();
      emit("ShipmentCreated", [id, signerAddress, carrier, receiver, sensor, minTemp, maxTemp, value, penaltyBps, product]);
      return tx;
    },
    startTransit: async (id) => {
      const s = chain.shipments[Number(id)];
      if (signerAddress !== s.carrier) throw { data: coldChainInterface.encodeErrorResult("Unauthorized", [signerAddress]) };
      chain.shipments[Number(id)] = { ...s, status: 1n, startedAt: 200n };
      const tx = mine();
      emit("ShipmentStarted", [id, signerAddress, 200]);
      return tx;
    },
    submitReading: async (id, sequence, temperature, timestamp) => {
      const s = chain.shipments[Number(id)];
      if (Number(sequence) !== Number(s.readingCount)) {
        throw { data: coldChainInterface.encodeErrorResult("SequenceMismatch", [s.readingCount, sequence]) };
      }
      const inRange = temperature >= Number(s.minTemp) && temperature <= Number(s.maxTemp);
      chain.shipments[Number(id)] = {
        ...s,
        readingCount: s.readingCount + 1n,
        lastReadingAt: BigInt(timestamp),
        status: inRange ? s.status : 2n,
        violationCount: inRange ? s.violationCount : s.violationCount + 1n,
      };
      const tx = mine();
      emit("ReadingSubmitted", [id, sequence, temperature, timestamp, signerAddress, inRange]);
      if (!inRange) emit("TemperatureViolation", [id, temperature, timestamp, Number(s.violationCount)]);
      return tx;
    },
    confirmDelivery: async (id) => {
      const s = chain.shipments[Number(id)];
      const refund = s.status === 2n ? (s.payment * s.penaltyBps) / 10_000n : 0n;
      chain.shipments[Number(id)] = { ...s, status: 3n, deliveredAt: 1_000n };
      chain.pending[s.carrier] = s.payment - refund;
      chain.pending[s.manufacturer] = refund;
      const tx = mine();
      emit("ShipmentDelivered", [id, signerAddress, 1_000, s.payment - refund, refund]);
      return tx;
    },
    withdraw: async () => {
      chain.pending[signerAddress] = 0n;
      return mine();
    },
  };
}

vi.mock("./lib/chain.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createProvider: () => fakeProvider,
    readContract: () => contractFor(null),
    writeContract: (signer) => contractFor(signer.address),
  };
});

beforeEach(() => {
  chain.block = 1;
  chain.shipments = {};
  chain.logs = [];
  chain.pending = {};
  chain.code = "0x6080";
});

describe("App", () => {
  test("shows a deploy hint when the contract is missing", async () => {
    chain.code = "0x";
    render(<App />);
    expect(await screen.findByText(/нет кода контракта/)).toBeInTheDocument();
  });

  test("walks the demo scenario: create → start → violation → confirm → withdraw", async () => {
    render(<App />);
    expect(await screen.findByText(/блок #/)).toBeInTheDocument();

    // manufacturer creates a shipment (form is visible only for this role)
    fireEvent.submit(screen.getByRole("button", { name: /Создать и задепонировать/ }).closest("form"));
    expect(await screen.findByText(/Создание поставки: подтверждено/)).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: /#1 Vaccine Batch A17/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Отменить поставку/ })).toBeInTheDocument();

    // carrier accepts
    fireEvent.click(screen.getByRole("button", { name: /^Перевозчик/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Принять и начать/ }));
    expect(await screen.findByText(/Начало транспортировки: подтверждено/)).toBeInTheDocument();
    expect(await screen.findByText(/Телеметрия отсутствует/)).toBeInTheDocument();

    // the in-browser sensor signs a reading that is out of range
    const sensor = await screen.findByRole("heading", { name: /Датчик и шлюз/i });
    expect(sensor).toBeInTheDocument();
    fireEvent.change(screen.getByRole("slider"), { target: { value: "12.7" } });
    fireEvent.click(screen.getByRole("button", { name: /Подписать и отправить показание/ }));
    expect(await screen.findByText(/Показание #0 \(12.7 °C\): подтверждено/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/Нарушение №1: 12.7 °C/)).toBeInTheDocument());
    expect(screen.queryByText(/Телеметрия отсутствует/)).not.toBeInTheDocument();

    // a skipped reading is rejected with a decoded error
    fireEvent.click(screen.getByLabelText(/Пропустить показание/));
    fireEvent.click(screen.getByRole("button", { name: /Подписать и отправить показание/ }));
    expect(await screen.findByText(/Пропуск в последовательности/)).toBeInTheDocument();
    expect(screen.getByText("SequenceMismatch")).toBeInTheDocument();

    // receiver confirms; settlement honours the penalty
    fireEvent.click(screen.getByRole("button", { name: /^Получатель/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Подтвердить доставку/ }));
    expect(await screen.findByText(/Подтверждение доставки: подтверждено/)).toBeInTheDocument();
    const settlement = (await screen.findByRole("heading", { name: /Итоговый расчёт/i })).closest("section");
    await waitFor(() => expect(within(settlement).getByText("0.8 ETH")).toBeInTheDocument());
    expect(within(settlement).getByText("0.2 ETH")).toBeInTheDocument();

    // carrier withdraws the credited payout
    fireEvent.click(screen.getByRole("button", { name: /^Перевозчик/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Вывести" }));
    expect(await screen.findByText(/Вывод средств: подтверждено/)).toBeInTheDocument();
  });
});
