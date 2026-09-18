import { Notice, TxHash } from "./primitives.jsx";

/** Lifecycle of the last transaction sent from the UI, including decoded contract reverts. */
export function TxStatus({ state, onDismiss }) {
  if (state.status === "idle") return null;

  if (state.status === "pending") {
    return (
      <Notice tone="info">
        <span className="spinner" /> {state.label}: транзакция отправлена, ждём блок…
      </Notice>
    );
  }

  if (state.status === "success") {
    return (
      <Notice tone="success">
        {state.label}: подтверждено в блоке #{state.blockNumber}, tx <TxHash value={state.txHash} />
        <button type="button" className="btn btn-link" onClick={onDismiss}>
          скрыть
        </button>
      </Notice>
    );
  }

  return (
    <Notice tone="danger">
      <strong>{state.label}: отклонено.</strong> {state.error.message}
      {state.error.code ? <code className="error-code">{state.error.code}</code> : null}
      <button type="button" className="btn btn-link" onClick={onDismiss}>
        скрыть
      </button>
    </Notice>
  );
}
