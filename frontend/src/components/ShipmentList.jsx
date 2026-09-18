import { formatEth, formatTemp } from "../lib/format.js";
import { StatusBadge } from "./primitives.jsx";

export function ShipmentList({ shipments, selectedId, onSelect }) {
  if (shipments.length === 0) {
    return <p className="muted">Поставок пока нет. Переключитесь на роль «Производитель» и создайте первую.</p>;
  }
  return (
    <ul className="shipment-list">
      {shipments.map((s) => (
        <li key={s.id}>
          <button
            type="button"
            className={`shipment-item ${s.id === selectedId ? "shipment-item-active" : ""}`}
            onClick={() => onSelect(s.id)}
          >
            <span className="shipment-item-title">
              <strong>#{s.id}</strong> {s.product || "(без названия)"}
            </span>
            <span className="shipment-item-meta">
              {formatTemp(s.minTemp)} … {formatTemp(s.maxTemp)} · {formatEth(s.payment)}
              {s.violationCount > 0 ? ` · нарушений: ${s.violationCount}` : ""}
            </span>
            <StatusBadge status={s.status} />
          </button>
        </li>
      ))}
    </ul>
  );
}
