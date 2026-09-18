import { roleForAddress } from "../lib/roles.js";
import { shortAddress, shortHash, statusMeta } from "../lib/format.js";

export function StatusBadge({ status }) {
  const meta = statusMeta(status);
  return (
    <span className={`badge badge-${meta.tone}`} title={meta.name}>
      {meta.label}
    </span>
  );
}

/** Address with the demo-role label when it is one of the known accounts. */
export function Address({ value }) {
  const role = roleForAddress(value);
  return (
    <span className="address" title={value}>
      {role ? <span className="address-role">{role.label}</span> : null}
      <code>{shortAddress(value)}</code>
    </span>
  );
}

export function TxHash({ value }) {
  return (
    <code className="hash" title={value}>
      {shortHash(value)}
    </code>
  );
}

export function Card({ title, children, className = "", aside }) {
  return (
    <section className={`card ${className}`}>
      {title ? (
        <header className="card-header">
          <h3>{title}</h3>
          {aside}
        </header>
      ) : null}
      {children}
    </section>
  );
}

export function Notice({ tone = "info", children }) {
  return <div className={`notice notice-${tone}`}>{children}</div>;
}
