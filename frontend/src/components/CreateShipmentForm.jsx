import { useState } from "react";
import { parseEther } from "ethers";
import { ROLES, SENSOR_WALLET } from "../lib/roles.js";
import { toDeci } from "../lib/format.js";
import { Card, Notice } from "./primitives.jsx";

const DEFAULTS = {
  product: "Vaccine Batch A17",
  minC: "2",
  maxC: "8",
  paymentEth: "1",
  penaltyPct: "20",
};

/** Client-side validation mirrors the contract's checks so the user sees the reason before a revert. */
export function validateForm(values) {
  const minC = Number(values.minC);
  const maxC = Number(values.maxC);
  const payment = Number(values.paymentEth);
  const penalty = Number(values.penaltyPct);
  if (!values.product.trim()) return "Укажите название продукта.";
  if (!Number.isFinite(minC) || !Number.isFinite(maxC)) return "Температуры должны быть числами.";
  if (minC >= maxC) return "Минимальная температура должна быть ниже максимальной.";
  if (!Number.isFinite(payment) || payment <= 0) return "Сумма оплаты должна быть больше нуля.";
  if (!Number.isFinite(penalty) || penalty < 0 || penalty > 100) return "Штраф — от 0 до 100 %.";
  return null;
}

export function CreateShipmentForm({ onSubmit, isPending }) {
  const [values, setValues] = useState(DEFAULTS);
  const [validation, setValidation] = useState(null);
  const carrier = ROLES.find((r) => r.id === "carrier");
  const receiver = ROLES.find((r) => r.id === "receiver");

  const update = (field) => (e) => setValues((v) => ({ ...v, [field]: e.target.value }));

  const handleSubmit = (e) => {
    e.preventDefault();
    const problem = validateForm(values);
    setValidation(problem);
    if (problem) return;
    onSubmit({
      product: values.product.trim(),
      carrier: carrier.wallet.address,
      receiver: receiver.wallet.address,
      sensor: SENSOR_WALLET.address,
      minTemp: toDeci(values.minC),
      maxTemp: toDeci(values.maxC),
      penaltyBps: Math.round(Number(values.penaltyPct) * 100),
      value: parseEther(values.paymentEth),
    });
  };

  return (
    <Card title="Новая поставка">
      <form className="form" onSubmit={handleSubmit}>
        <label>
          Продукт
          <input value={values.product} onChange={update("product")} />
        </label>
        <div className="form-row">
          <label>
            Мин. °C
            <input type="number" step="0.1" value={values.minC} onChange={update("minC")} />
          </label>
          <label>
            Макс. °C
            <input type="number" step="0.1" value={values.maxC} onChange={update("maxC")} />
          </label>
        </div>
        <div className="form-row">
          <label>
            Оплата, ETH (escrow)
            <input type="number" step="0.01" min="0" value={values.paymentEth} onChange={update("paymentEth")} />
          </label>
          <label>
            Штраф при нарушении, %
            <input type="number" step="1" min="0" max="100" value={values.penaltyPct} onChange={update("penaltyPct")} />
          </label>
        </div>
        <p className="muted small">
          Перевозчик — {carrier.label}, получатель — {receiver.label}, датчик — ключ демо-сенсора (аккаунт #9).
          Сумма оплаты блокируется в контракте до завершения поставки.
        </p>
        {validation ? <Notice tone="warning">{validation}</Notice> : null}
        <button type="submit" className="btn btn-primary" disabled={isPending}>
          Создать и задепонировать оплату
        </button>
      </form>
    </Card>
  );
}
