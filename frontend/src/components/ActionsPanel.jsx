import { STATUS, formatBps, formatDuration, isActiveStatus } from "../lib/format.js";

const SETTLEMENT_TIMEOUT = 30 * 24 * 3600;

/**
 * Which contract calls the active role may make on this shipment right now.
 * Mirrors the contract's access rules so the buttons explain themselves instead of reverting.
 */
export function availableActions(shipment, roleId, chainNow) {
  const actions = [];
  const active = isActiveStatus(shipment.status);
  const settleAt = shipment.startedAt + SETTLEMENT_TIMEOUT;
  const settleWait = settleAt - chainNow;

  if (roleId === "carrier") {
    if (shipment.status === STATUS.CREATED) {
      actions.push({ id: "startTransit", label: "Принять и начать транспортировку", tone: "primary" });
    }
  }
  if (roleId === "manufacturer" && shipment.status === STATUS.CREATED) {
    actions.push({ id: "cancelShipment", label: "Отменить поставку (вернуть escrow)", tone: "danger" });
  }
  if (roleId === "receiver" && active) {
    actions.push({ id: "confirmDelivery", label: "Подтвердить доставку и рассчитаться", tone: "primary" });
  }
  if ((roleId === "carrier" || roleId === "manufacturer") && active) {
    actions.push({
      id: "settleExpired",
      label: "Рассчитаться без получателя",
      tone: "secondary",
      disabled: settleWait > 0,
      hint:
        settleWait > 0
          ? `Доступно через ${formatDuration(settleWait)} после начала транспортировки (30 дней), если получатель молчит. Штраф ${formatBps(shipment.penaltyBps)} удерживается в любом случае.`
          : `Получатель не подтвердил доставку 30 дней — любая из сторон может завершить расчёт. Без подтверждения получателя штраф ${formatBps(shipment.penaltyBps)} удерживается даже без зафиксированных нарушений.`,
    });
  }
  return actions;
}

export function ActionsPanel({ shipment, roleId, roleLabel, chainNow, onAction, isPending }) {
  const actions = availableActions(shipment, roleId, chainNow);

  if (actions.length === 0) {
    return <p className="muted small">Для роли «{roleLabel}» в текущем статусе действий нет.</p>;
  }

  return (
    <div className="actions">
      {actions.map((a) => (
        <div key={a.id} className="action">
          <button
            type="button"
            className={`btn btn-${a.tone}`}
            disabled={isPending || a.disabled}
            onClick={() => onAction(a.id, a.label)}
          >
            {a.label}
          </button>
          {a.hint ? <span className="muted small">{a.hint}</span> : null}
        </div>
      ))}
    </div>
  );
}
