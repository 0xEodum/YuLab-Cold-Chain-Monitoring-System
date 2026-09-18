import { ROLES } from "../lib/roles.js";
import { formatEth, shortAddress } from "../lib/format.js";

/**
 * "I am the …" switcher. Each role is a Hardhat dev account whose key lives in the page —
 * fine for a local demo, and it lets one browser window play all three parties.
 */
export function RoleSwitcher({ activeRoleId, onChange, balances, onWithdraw, isPending }) {
  return (
    <div className="roles" role="group" aria-label="Роль">
      {ROLES.map((role) => {
        const active = role.id === activeRoleId;
        const balance = balances[role.id];
        const pending = balance?.pending ?? 0n;
        return (
          <div key={role.id} className={`role ${active ? "role-active" : ""}`}>
            <button type="button" className="role-select" onClick={() => onChange(role.id)} aria-pressed={active}>
              <span className="role-label">{role.label}</span>
              <span className="role-address">{shortAddress(role.wallet.address)}</span>
              <span className="role-balance">{balance ? formatEth(balance.eth, 3) : "…"}</span>
            </button>
            {pending > 0n ? (
              <div className="role-pending">
                <span>к выводу {formatEth(pending)}</span>
                {active ? (
                  <button type="button" className="btn btn-small" disabled={isPending} onClick={onWithdraw}>
                    Вывести
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
