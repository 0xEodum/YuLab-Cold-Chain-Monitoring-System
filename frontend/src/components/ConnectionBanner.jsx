import { CONTRACT_ADDRESS, EXPECTED_CHAIN_ID, RPC_URL } from "../lib/chain.js";
import { Notice } from "./primitives.jsx";

export function ConnectionBanner({ health, blockNumber }) {
  if (health.state === "connecting") return <Notice tone="info">Подключение к ноде {RPC_URL}…</Notice>;

  if (health.state === "error") {
    return (
      <Notice tone="danger">
        Нода {RPC_URL} недоступна. Запустите в корне проекта <code>npm run node</code>, затем <code>npm run deploy</code>.
      </Notice>
    );
  }

  if (!health.chainMatches) {
    return (
      <Notice tone="warning">
        Нода отвечает, но chainId = {String(health.chainId)}, ожидается {String(EXPECTED_CHAIN_ID)}.
      </Notice>
    );
  }

  if (!health.contractDeployed) {
    return (
      <Notice tone="warning">
        По адресу <code>{CONTRACT_ADDRESS}</code> нет кода контракта. Выполните <code>npm run deploy</code> — после
        перезапуска ноды деплой нужно повторить.
      </Notice>
    );
  }

  return (
    <div className="conn-ok">
      <span className="dot dot-ok" /> localhost · chainId {String(health.chainId)} · блок #{blockNumber} · контракт{" "}
      <code title={CONTRACT_ADDRESS}>{CONTRACT_ADDRESS.slice(0, 10)}…</code>
    </div>
  );
}
