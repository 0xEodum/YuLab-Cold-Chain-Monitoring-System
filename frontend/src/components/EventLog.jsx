import { formatEth, formatTemp, formatTime } from "../lib/format.js";
import { Address, TxHash } from "./primitives.jsx";

/** Human wording for each contract event; falls back to raw args. */
function describeEvent(ev) {
  const a = ev.args;
  switch (ev.name) {
    case "ShipmentCreated":
      return `Создана «${a.product}», диапазон ${formatTemp(a.minTemp)}…${formatTemp(a.maxTemp)}, escrow ${formatEth(a.payment)}, штраф ${Number(a.penaltyBps) / 100} %`;
    case "ShipmentStarted":
      return `Перевозчик принял поставку, мониторинг начат (${formatTime(a.timestamp)})`;
    case "ReadingSubmitted":
      return `Показание #${a.sequence}: ${formatTemp(a.temperature)} ${a.inRange ? "в норме" : "ВНЕ ДИАПАЗОНА"}`;
    case "TemperatureViolation":
      return `Нарушение №${Number(a.violationIndex) + 1}: ${formatTemp(a.temperature)} в ${formatTime(a.timestamp)}`;
    case "TelemetryAnchored":
      return `Заякорен хэш батча ${a.dataHash.slice(0, 14)}… (${formatTime(a.fromTimestamp)} — ${formatTime(a.toTimestamp)})`;
    case "ShipmentDelivered":
      return `Доставка подтверждена: перевозчику ${formatEth(a.carrierPayout)}, возврат производителю ${formatEth(a.manufacturerRefund)}`;
    case "ShipmentExpired":
      return `Расчёт по истечении срока: перевозчику ${formatEth(a.carrierPayout)}, возврат производителю ${formatEth(a.manufacturerRefund)}`;
    case "ShipmentCancelled":
      return `Отменена, escrow ${formatEth(a.refund)} возвращён производителю`;
    default:
      return JSON.stringify(a);
  }
}

const TONES = {
  TemperatureViolation: "danger",
  ShipmentDelivered: "success",
  ShipmentExpired: "warning",
  ShipmentCancelled: "muted",
};

/**
 * Immutable history: every event with the block that sealed it. The point of the demo —
 * once a violation is here, no participant can edit or delete it.
 */
export function EventLog({ events }) {
  if (events.length === 0) return <p className="muted">Событий нет.</p>;
  return (
    <ol className="timeline">
      {[...events].reverse().map((ev) => (
        <li key={`${ev.txHash}-${ev.logIndex}`} className={`timeline-item tone-${TONES[ev.name] ?? "neutral"}`}>
          <div className="timeline-head">
            <code className="event-name">{ev.name}</code>
            <span className="muted small">
              блок #{ev.blockNumber} · <TxHash value={ev.txHash} />
            </span>
          </div>
          <div>{describeEvent(ev)}</div>
        </li>
      ))}
    </ol>
  );
}

export function ViolationsList({ violations }) {
  if (violations.length === 0) return <p className="muted small">Нарушений не зафиксировано.</p>;
  return (
    <ul className="plain-list">
      {violations.map((v, i) => (
        <li key={i}>
          <strong>{formatTemp(v.temperature)}</strong> — датчик: {formatTime(v.timestamp)}, записано в цепочку: {formatTime(v.recordedAt)}
        </li>
      ))}
    </ul>
  );
}

export function AnchorsList({ anchors }) {
  if (anchors.length === 0) return <p className="muted small">Якорей телеметрии нет.</p>;
  return (
    <ul className="plain-list">
      {anchors.map((a, i) => (
        <li key={i}>
          <code title={a.dataHash}>{a.dataHash.slice(0, 18)}…</code> {formatTime(a.fromTimestamp)} — {formatTime(a.toTimestamp)} ·{" "}
          <Address value={a.anchoredBy} />
        </li>
      ))}
    </ul>
  );
}
