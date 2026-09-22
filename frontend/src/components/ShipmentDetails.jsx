import { STATUS, formatBps, formatDuration, formatEth, formatTemp, formatTime, isActiveStatus } from "../lib/format.js";
import { ActionsPanel } from "./ActionsPanel.jsx";
import { AnchorsList, EventLog, ViolationsList } from "./EventLog.jsx";
import { ReadingsTable } from "./ReadingsTable.jsx";
import { SensorPanel } from "./SensorPanel.jsx";
import { TemperatureChart } from "./TemperatureChart.jsx";
import { Address, Card, Notice, StatusBadge } from "./primitives.jsx";

/** Readings older than this while in transit are treated as a broken telemetry stream. */
const TELEMETRY_GAP_SECONDS = 15 * 60;

/**
 * The contract does not require a minimum number of readings before settlement (documented
 * MVP gap), so the UI must make missing or truncated telemetry impossible to overlook —
 * especially for the receiver about to confirm delivery.
 */
export function telemetryWarning(shipment, chainNow) {
  if (!isActiveStatus(shipment.status) && shipment.status !== STATUS.DELIVERED && shipment.status !== STATUS.EXPIRED) {
    return null;
  }
  if (shipment.readingCount === 0) {
    return "Телеметрия отсутствует: за время транспортировки не передано ни одного показания. Соблюдение температурного режима ничем не подтверждено.";
  }
  const reference = isActiveStatus(shipment.status) ? chainNow : shipment.deliveredAt;
  const gap = reference - shipment.lastReadingAt;
  if (gap > TELEMETRY_GAP_SECONDS) {
    return `Телеметрия оборвана: последнее показание #${shipment.readingCount - 1} было ${formatDuration(gap)} назад. Возможно, шлюз перестал передавать данные.`;
  }
  return null;
}

export function ShipmentDetails({ data, role, provider, signerContract, chainId, onAction, run, isPending }) {
  const { shipment, violations, anchors, settlement, expiredSettlement, readings, events, chainNow } = data;
  const warning = telemetryWarning(shipment, chainNow);
  const active = isActiveStatus(shipment.status);
  const canAnchor = role.id === "carrier" || role.id === "manufacturer";
  const settled = shipment.status === STATUS.DELIVERED || shipment.status === STATUS.EXPIRED;

  return (
    <div className="details">
      <header className="details-header">
        <div>
          <h2>
            #{shipment.id} {shipment.product}
          </h2>
          <div className="muted small">
            создана {formatTime(shipment.createdAt)}
            {shipment.startedAt ? ` · в пути с ${formatTime(shipment.startedAt)}` : ""}
            {shipment.deliveredAt ? ` · завершена ${formatTime(shipment.deliveredAt)}` : ""}
          </div>
        </div>
        <StatusBadge status={shipment.status} />
      </header>

      <div className="grid-2">
        <Card title="Условия поставки">
          <dl className="terms">
            <dt>Диапазон</dt>
            <dd>
              {formatTemp(shipment.minTemp)} … {formatTemp(shipment.maxTemp)}
            </dd>
            <dt>Escrow</dt>
            <dd>{formatEth(shipment.payment)}</dd>
            <dt>Штраф при нарушении</dt>
            <dd>{formatBps(shipment.penaltyBps)} от оплаты</dd>
            <dt>Производитель</dt>
            <dd>
              <Address value={shipment.manufacturer} />
            </dd>
            <dt>Перевозчик</dt>
            <dd>
              <Address value={shipment.carrier} />
            </dd>
            <dt>Получатель</dt>
            <dd>
              <Address value={shipment.receiver} />
            </dd>
            <dt>Ключ датчика</dt>
            <dd>
              <Address value={shipment.sensor} />
            </dd>
          </dl>
        </Card>

        <Card title={settled ? "Итоговый расчёт" : "Расчёт при завершении сейчас"}>
          <dl className="terms">
            <dt>Показаний</dt>
            <dd>{shipment.readingCount}</dd>
            <dt>Нарушений</dt>
            <dd className={shipment.violationCount > 0 ? "text-danger" : ""}>{shipment.violationCount}</dd>
            <dt>Перевозчику</dt>
            <dd>{formatEth(settlement.carrierPayout)}</dd>
            <dt>Возврат производителю</dt>
            <dd>{formatEth(settlement.manufacturerRefund)}</dd>
          </dl>
          <p className="muted small">
            Правило зафиксировано при создании: {shipment.violationCount > 0 ? "есть нарушение — удерживается штраф" : "нет нарушений — перевозчик получает всё"}
            . Выплаты начисляются на баланс и забираются кнопкой «Вывести».
          </p>
          {active && expiredSettlement ? (
            <p className="muted small">
              Без подтверждения получателя (расчёт по истечении 30 дней): перевозчику{" "}
              {formatEth(expiredSettlement.carrierPayout)}, возврат {formatEth(expiredSettlement.manufacturerRefund)} —
              штраф удерживается всегда, поэтому скрывать телеметрию невыгодно.
            </p>
          ) : null}
          <ActionsPanel
            shipment={shipment}
            roleId={role.id}
            roleLabel={role.label}
            chainNow={chainNow}
            onAction={onAction}
            isPending={isPending}
          />
        </Card>
      </div>

      {warning ? <Notice tone="warning">{warning}</Notice> : null}

      <Card title="Температура" aside={<span className="muted small">{readings.length} показаний из событий ReadingSubmitted</span>}>
        <TemperatureChart readings={readings} minTemp={shipment.minTemp} maxTemp={shipment.maxTemp} />
        <ReadingsTable readings={readings} />
      </Card>

      {active ? (
        <SensorPanel
          shipment={shipment}
          provider={provider}
          signerContract={signerContract}
          chainId={chainId}
          canAnchor={canAnchor}
          run={run}
          isPending={isPending}
        />
      ) : null}

      <div className="grid-2">
        <Card title="Зафиксированные нарушения">
          <ViolationsList violations={violations} />
        </Card>
        <Card title="Якоря телеметрии">
          <AnchorsList anchors={anchors} />
        </Card>
      </div>

      <Card title="История в блокчейне" aside={<span className="muted small">неизменяемый журнал событий</span>}>
        <EventLog events={events} />
      </Card>
    </div>
  );
}
