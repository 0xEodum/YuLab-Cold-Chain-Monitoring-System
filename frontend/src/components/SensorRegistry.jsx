import { REGISTRAR_WALLET } from "../lib/roles.js";
import { formatTime } from "../lib/format.js";
import { Address, Card, Notice } from "./primitives.jsx";

/**
 * The sensor registry (FR-01). A shipment may only be assigned to a registered, active device,
 * so an arbitrary key cannot be passed off as a trusted sensor.
 *
 * Retiring a device is deliberately forward-looking only: shipments already created keep
 * verifying against the key fixed at creation time, so a registrar can never rewrite history
 * or strand a shipment mid-transit.
 */
export function SensorRegistry({ record, onRegister, onSetActive, isPending }) {
  if (!record) return null;

  const tone = !record.isRegistered ? "warning" : record.active ? "info" : "warning";
  const summary = !record.isRegistered
    ? "Датчик не зарегистрирован — создать поставку с ним нельзя."
    : record.active
      ? "Датчик зарегистрирован и активен."
      : "Датчик выведен из эксплуатации: новые поставки ему назначить нельзя, уже идущие не затронуты.";

  return (
    <Card title="Реестр датчиков" aside={<span className="muted small">регистратор — аккаунт #0</span>}>
      <dl className="terms">
        <dt>Ключ датчика</dt>
        <dd>
          <Address value={record.address} />
        </dd>
        <dt>Статус</dt>
        <dd className={record.isRegistered && record.active ? "" : "text-danger"}>
          {record.isRegistered ? (record.active ? "активен" : "выведен из эксплуатации") : "не зарегистрирован"}
        </dd>
        {record.isRegistered ? (
          <>
            <dt>deviceIdHash</dt>
            <dd>
              <code className="small">{record.deviceIdHash.slice(0, 18)}…</code>
            </dd>
            <dt>Зарегистрирован</dt>
            <dd>{formatTime(record.registeredAt)}</dd>
          </>
        ) : null}
      </dl>

      <Notice tone={tone}>{summary}</Notice>

      <div className="actions">
        {!record.isRegistered ? (
          <div className="action">
            <button type="button" className="btn btn-primary" disabled={isPending} onClick={onRegister}>
              Зарегистрировать датчик
            </button>
            <span className="muted small">
              Подпишет регистратор {REGISTRAR_WALLET.address.slice(0, 10)}… — только он имеет право на реестр.
            </span>
          </div>
        ) : (
          <div className="action">
            <button
              type="button"
              className={`btn ${record.active ? "btn-danger" : "btn-secondary"}`}
              disabled={isPending}
              onClick={() => onSetActive(!record.active)}
            >
              {record.active ? "Вывести из эксплуатации" : "Вернуть в эксплуатацию"}
            </button>
            <span className="muted small">
              {record.active
                ? "После этого создать новую поставку с этим датчиком будет нельзя (SensorInactive)."
                : "Вернёт возможность назначать датчик новым поставкам."}
            </span>
          </div>
        )}
      </div>

      <p className="muted small">
        В блокчейне хранится только хэш off-chain идентификатора устройства — серийный номер, модель
        и сертификат поверки остаются вне цепи.
      </p>
    </Card>
  );
}
