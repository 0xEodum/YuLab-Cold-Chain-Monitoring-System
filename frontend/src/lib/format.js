import { formatEther } from "ethers";

export const STATUS = Object.freeze({
  CREATED: 0,
  IN_TRANSIT: 1,
  COMPROMISED: 2,
  DELIVERED: 3,
  CANCELLED: 4,
  EXPIRED: 5,
});

export const STATUS_META = Object.freeze({
  [STATUS.CREATED]: { name: "CREATED", label: "Создана", tone: "neutral" },
  [STATUS.IN_TRANSIT]: { name: "IN_TRANSIT", label: "В пути", tone: "info" },
  [STATUS.COMPROMISED]: { name: "COMPROMISED", label: "Нарушение", tone: "danger" },
  [STATUS.DELIVERED]: { name: "DELIVERED", label: "Доставлена", tone: "success" },
  [STATUS.CANCELLED]: { name: "CANCELLED", label: "Отменена", tone: "muted" },
  [STATUS.EXPIRED]: { name: "EXPIRED", label: "Истекла", tone: "warning" },
});

export function statusMeta(status) {
  return STATUS_META[Number(status)] ?? { name: String(status), label: "?", tone: "neutral" };
}

/** Statuses in which the contract still accepts readings and can be settled. */
export function isActiveStatus(status) {
  const s = Number(status);
  return s === STATUS.IN_TRANSIT || s === STATUS.COMPROMISED;
}

export function isTerminalStatus(status) {
  const s = Number(status);
  return s === STATUS.DELIVERED || s === STATUS.CANCELLED || s === STATUS.EXPIRED;
}

/** °C (number) -> tenths of °C (int32 as used on-chain). */
export function toDeci(celsius) {
  return Math.round(Number(celsius) * 10);
}

/** tenths of °C -> "x.y °C". Accepts number or bigint. */
export function formatTemp(deci) {
  return `${(Number(deci) / 10).toFixed(1)} °C`;
}

export function formatEth(wei, digits = 4) {
  const fixed = Number(formatEther(wei)).toFixed(digits);
  const trimmed = fixed.includes(".") ? fixed.replace(/\.?0+$/, "") : fixed;
  return `${trimmed} ETH`;
}

export function formatBps(bps) {
  const n = Number(bps);
  return `${(n / 100).toFixed(n % 100 === 0 ? 0 : 2)} %`;
}

export function shortAddress(address) {
  if (!address) return "—";
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function shortHash(hash) {
  if (!hash) return "—";
  return `${hash.slice(0, 10)}…${hash.slice(-6)}`;
}

/** Unix seconds (number | bigint) -> local date-time string; 0 -> "—". */
export function formatTime(seconds) {
  const s = Number(seconds);
  if (!s) return "—";
  return new Date(s * 1000).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function formatClock(seconds) {
  return new Date(Number(seconds) * 1000).toLocaleTimeString("ru-RU");
}

export function formatDuration(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds)));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d} д ${h} ч`;
  if (h > 0) return `${h} ч ${m} мин`;
  return `${m} мин`;
}
