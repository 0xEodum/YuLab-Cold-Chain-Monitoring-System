import { useState } from "react";
import { verifyTelemetry } from "../lib/sensor.js";
import { formatTemp, toDeci } from "../lib/format.js";
import { Card, Notice } from "./primitives.jsx";

const STATUS_LABELS = {
  ok: { label: "совпадает", tone: "" },
  tampered: { label: "ПОДМЕНЕНА", tone: "text-danger" },
  missing: { label: "ОТСУТСТВУЕТ в хранилище", tone: "text-danger" },
  unanchored: { label: "нет обязательства в блокчейне", tone: "text-danger" },
};

/** Apply an edit to the off-chain store — the chain is deliberately left untouched. */
export function tamperRecord(store, sequence, temperature) {
  return store.map((r) => (Number(r.sequence) === sequence ? { ...r, temperature } : r));
}

/**
 * The off-chain half of the hybrid architecture, and the audit that keeps it honest.
 *
 * The store is ordinary browser state standing in for a telemetry database — fully editable,
 * exactly like a real one. What makes it trustworthy is not the storage but the chain: every
 * record was hashed by the sensor, and that hash was signed together with the reading and
 * written to `ReadingSubmitted`. Re-hashing a stored record and comparing it with the on-chain
 * commitment therefore proves whether the store still holds what the device measured — and
 * since the commitment carries the sensor's signature, it is the store that is proven wrong.
 */
export function TelemetryAudit({ store, readings, onTamper }) {
  const [sequence, setSequence] = useState("");
  const [celsius, setCelsius] = useState("4.5");

  const { ok, results } = verifyTelemetry(store, readings);
  const problems = results.filter((r) => r.status !== "ok");

  const handleTamper = (e) => {
    e.preventDefault();
    const seq = Number(sequence);
    if (!Number.isInteger(seq) || !Number.isFinite(Number(celsius))) return;
    onTamper(seq, toDeci(celsius));
  };

  return (
    <Card title="Off-chain хранилище телеметрии" aside={<span className="muted small">{store.length} записей · сверка с блокчейном</span>}>
      <p className="muted small">
        Полные записи лежат здесь, вне блокчейна; в цепочку попал только их хэш — но подписанный датчиком вместе с
        показанием. Поэтому любую правку хранилища можно доказать.
      </p>

      {results.length === 0 ? (
        <p className="muted small">Показаний пока нет.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>#</th>
                <th>Температура в хранилище</th>
                <th>Хэш записи</th>
                <th>Сверка с блокчейном</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r) => {
                const record = store.find((s) => Number(s.sequence) === r.sequence);
                const status = STATUS_LABELS[r.status];
                return (
                  <tr key={r.sequence} className={r.status === "ok" ? "" : "row-violation"}>
                    <td>{r.sequence}</td>
                    <td>{record ? formatTemp(record.temperature) : "—"}</td>
                    <td>
                      <code>{(r.actual ?? r.expected).slice(0, 14)}…</code>
                    </td>
                    <td className={status.tone}>{status.label}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {results.length > 0 ? (
        <Notice tone={ok ? "info" : "warning"}>
          {ok
            ? "Все записи совпадают с обязательствами в блокчейне — хранилище не изменялось."
            : `Расхождений: ${problems.length}. Блокчейн переписать нельзя, значит изменилось хранилище.`}
        </Notice>
      ) : null}

      {store.length > 0 ? (
        <form className="form-row" onSubmit={handleTamper}>
          <label>
            Подменить запись #
            <input type="number" min="0" value={sequence} onChange={(e) => setSequence(e.target.value)} placeholder={String(store[0].sequence)} />
          </label>
          <label>
            на, °C
            <input type="number" step="0.1" value={celsius} onChange={(e) => setCelsius(e.target.value)} />
          </label>
          <button type="submit" className="btn btn-danger" disabled={sequence === ""}>
            Изменить в хранилище
          </button>
        </form>
      ) : null}
    </Card>
  );
}
