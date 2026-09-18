import { useEffect, useMemo, useState } from "react";
import { useChain } from "./hooks/useChain.js";
import { useBalances, useShipment, useShipmentList } from "./hooks/useShipments.js";
import { useTransaction } from "./hooks/useTransaction.js";
import { writeContract } from "./lib/chain.js";
import { ROLES, roleById } from "./lib/roles.js";
import { ConnectionBanner } from "./components/ConnectionBanner.jsx";
import { CreateShipmentForm } from "./components/CreateShipmentForm.jsx";
import { RoleSwitcher } from "./components/RoleSwitcher.jsx";
import { ShipmentDetails } from "./components/ShipmentDetails.jsx";
import { ShipmentList } from "./components/ShipmentList.jsx";
import { TxStatus } from "./components/TxStatus.jsx";
import { Card } from "./components/primitives.jsx";

const ACTION_LABELS = {
  startTransit: "Начало транспортировки",
  cancelShipment: "Отмена поставки",
  confirmDelivery: "Подтверждение доставки",
  settleExpired: "Расчёт по истечении срока",
};

export default function App() {
  const { provider, contract, blockNumber, health } = useChain();
  const ready = health.state === "ok" && health.chainMatches && health.contractDeployed;

  const [roleId, setRoleId] = useState("manufacturer");
  const role = roleById(roleId);
  const signerContract = useMemo(() => writeContract(role.wallet.connect(provider)), [role, provider]);

  const [selectedId, setSelectedId] = useState(null);
  const { shipments, error: listError } = useShipmentList(contract, blockNumber, ready);
  const { data, error: detailsError } = useShipment(contract, provider, selectedId, blockNumber, ready);
  const balances = useBalances(contract, provider, ROLES, blockNumber, ready);
  const { state: txState, run, reset, isPending } = useTransaction();

  // Select the newest shipment by default once the list arrives.
  useEffect(() => {
    if (selectedId === null && shipments.length > 0) setSelectedId(shipments[0].id);
  }, [shipments, selectedId]);

  const handleCreate = async (params) => {
    const receipt = await run("Создание поставки", () =>
      signerContract.createShipment(
        params.product,
        params.carrier,
        params.receiver,
        params.sensor,
        params.minTemp,
        params.maxTemp,
        params.penaltyBps,
        { value: params.value },
      ),
    );
    if (receipt) {
      const created = receipt.logs.map((l) => contract.interface.parseLog(l)).find((l) => l?.name === "ShipmentCreated");
      if (created) setSelectedId(Number(created.args.shipmentId));
    }
  };

  const handleAction = (actionId) => run(ACTION_LABELS[actionId] ?? actionId, () => signerContract[actionId](selectedId));
  const handleWithdraw = () => run("Вывод средств", () => signerContract.withdraw());

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <h1>Cold Chain Monitor</h1>
          <ConnectionBanner health={health} blockNumber={blockNumber} />
        </div>
        <RoleSwitcher activeRoleId={roleId} onChange={setRoleId} balances={balances} onWithdraw={handleWithdraw} isPending={isPending} />
      </header>

      <TxStatus state={txState} onDismiss={reset} />

      <main className="layout">
        <aside className="sidebar">
          <Card title="Поставки">
            {listError ? <p className="text-danger small">{listError.shortMessage ?? listError.message}</p> : null}
            <ShipmentList shipments={shipments} selectedId={selectedId} onSelect={setSelectedId} />
          </Card>
          {roleId === "manufacturer" && ready ? <CreateShipmentForm onSubmit={handleCreate} isPending={isPending} /> : null}
        </aside>

        <section className="content">
          {detailsError ? <p className="text-danger">{detailsError.shortMessage ?? detailsError.message}</p> : null}
          {data ? (
            <ShipmentDetails
              // remount per shipment so the sensor panel's auto mode and local state never
              // carry over to a different shipment
              key={data.shipment.id}
              data={data}
              role={role}
              provider={provider}
              signerContract={signerContract}
              chainId={health.chainId}
              onAction={handleAction}
              run={run}
              isPending={isPending}
            />
          ) : (
            <p className="muted">{ready ? "Выберите поставку слева." : ""}</p>
          )}
        </section>
      </main>
    </div>
  );
}
