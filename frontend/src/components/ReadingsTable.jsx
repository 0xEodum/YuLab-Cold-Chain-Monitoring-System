import { formatTemp, formatTime } from "../lib/format.js";
import { Address, TxHash } from "./primitives.jsx";

const DEFAULT_LIMIT = 12;

/** Table view of the on-chain reading history (from `ReadingSubmitted` logs), newest first. */
export function ReadingsTable({ readings, limit = DEFAULT_LIMIT }) {
  if (readings.length === 0) return null;
  const rows = [...readings].reverse().slice(0, limit);
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>#</th>
            <th>Время датчика</th>
            <th>Температура</th>
            <th>Отправил</th>
            <th>Блок / tx</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.sequence} className={r.inRange ? "" : "row-violation"}>
              <td>{r.sequence}</td>
              <td>{formatTime(r.timestamp)}</td>
              <td>
                {formatTemp(r.temperature)}
                {r.inRange ? "" : " ⚠"}
              </td>
              <td>
                <Address value={r.reporter} />
              </td>
              <td>
                #{r.blockNumber} <TxHash value={r.txHash} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {readings.length > limit ? (
        <p className="muted small">Показаны последние {limit} из {readings.length}.</p>
      ) : null}
    </div>
  );
}
