/**
 * Turn an ethers / contract error into a short human-readable message. Custom errors of the
 * contract are decoded via the ABI so the UI can explain *why* a transaction was rejected —
 * this is a big part of the demo (InvalidSignature, SequenceMismatch, Unauthorized, ...).
 */
const STATUS_NAMES = ["CREATED", "IN_TRANSIT", "COMPROMISED", "DELIVERED", "CANCELLED", "EXPIRED"];

const ERROR_MESSAGES = {
  Unauthorized: () => "Действие не разрешено этой роли.",
  InvalidStatus: (a) => `Недопустимо в текущем статусе поставки (${statusName(a.current)}).`,
  InvalidSignature: () => "Подпись датчика не сходится: данные были изменены или подписаны чужим ключом.",
  SequenceMismatch: (a) => `Пропуск в последовательности: ожидалось показание #${a.expected}, получено #${a.actual}.`,
  StaleReading: (a) => `Показание устарело: таймстамп ${a.timestamp} не позже последнего (${a.lastReadingAt}).`,
  ReadingBeforeTransit: () => "Показание датировано раньше начала транспортировки.",
  ReadingFromFuture: () => "Таймстамп показания слишком далеко в будущем.",
  ShipmentNotFound: (a) => `Поставка #${a.shipmentId} не найдена.`,
  ZeroAddress: (a) => `Адрес поля «${a.field}» не задан.`,
  SensorNotRegistered: (a) => `Датчик ${short(a.sensor)} не зарегистрирован в реестре.`,
  SensorInactive: (a) => `Датчик ${short(a.sensor)} выведен из эксплуатации — новые поставки ему нельзя назначить.`,
  SensorAlreadyRegistered: (a) => `Датчик ${short(a.sensor)} уже есть в реестре.`,
  EmptyDeviceIdHash: () => "Нужен ненулевой хэш идентификатора устройства.",
  EmptyTelemetryHash: () => "Показание должно ссылаться на off-chain запись (telemetryHash не задан).",
  InvalidTemperatureRange: () => "Минимальная температура должна быть ниже максимальной.",
  InvalidPenalty: () => "Штраф не может превышать 100 %.",
  ZeroPayment: () => "Сумма оплаты должна быть больше нуля.",
  InvalidAnchorRange: () => "Некорректный интервал батча телеметрии.",
  SettlementNotYetAvailable: (a) =>
    `Расчёт без получателя будет доступен с ${new Date(Number(a.availableAt) * 1000).toLocaleString("ru-RU")}.`,
  NothingToWithdraw: () => "Нет средств к выводу.",
  TransferFailed: () => "Перевод средств не удался.",
};

function short(address) {
  return `${String(address).slice(0, 10)}…`;
}

function statusName(value) {
  return STATUS_NAMES[Number(value)] ?? String(value);
}

/** Extract revert data from the various shapes ethers v6 produces. */
export function revertData(err) {
  return err?.data ?? err?.info?.error?.data ?? err?.error?.data ?? undefined;
}

/** @returns {{ name: string, args: object } | undefined} decoded custom error */
export function decodeContractError(iface, err) {
  const data = revertData(err);
  if (typeof data !== "string" || !data.startsWith("0x") || data.length < 10) return undefined;
  try {
    const parsed = iface.parseError(data);
    if (!parsed) return undefined;
    return { name: parsed.name, args: parsed.args };
  } catch {
    return undefined;
  }
}

export function describeError(iface, err) {
  const decoded = iface ? decodeContractError(iface, err) : undefined;
  if (decoded) {
    const render = ERROR_MESSAGES[decoded.name];
    const text = render ? render(decoded.args) : `Контракт отклонил операцию: ${decoded.name}`;
    return { code: decoded.name, message: text };
  }
  if (err?.code === "INSUFFICIENT_FUNDS") return { code: err.code, message: "Недостаточно ETH на счёте." };
  if (err?.code === "NETWORK_ERROR" || /fetch|ECONNREFUSED/i.test(err?.message ?? "")) {
    return { code: "NETWORK", message: "Нода недоступна. Запущен ли `npm run node` на 127.0.0.1:8545?" };
  }
  return { code: err?.code ?? "UNKNOWN", message: err?.shortMessage ?? err?.message ?? String(err) };
}
