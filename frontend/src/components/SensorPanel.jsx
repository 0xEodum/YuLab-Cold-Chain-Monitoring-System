import { useEffect, useRef, useState } from "react";
import { CONTRACT_ADDRESS } from "../lib/chain.js";
import { SENSOR_WALLET, walletForAccount } from "../lib/roles.js";
import { formatTemp, toDeci } from "../lib/format.js";
import {
  buildMeasurement,
  DEMO_DEVICE_ID,
  nextTimestamp,
  signReading,
  telemetryBatchHash,
  telemetryRecordHash,
  temperatureAt,
} from "../lib/sensor.js";
import { Card, Notice } from "./primitives.jsx";

const INTERVAL_OPTIONS = [2000, 3000, 5000];
const TEMP_MIN_C = -10;
const TEMP_MAX_C = 20;
/** Account #8 stands in for "someone else's key" in the forged-signature demo. */
const IMPOSTOR_WALLET = walletForAccount(8);

const TAMPER_MODES = [
  { id: "none", label: "Честная передача", hint: "Показание подписано датчиком и передано без изменений." },
  {
    id: "alter",
    label: "Подменить температуру после подписи",
    hint: "Датчик подписал реальное значение, а шлюз отправляет «красивое». Контракт восстановит подписанта и отвергнет (InvalidSignature).",
  },
  {
    id: "skip",
    label: "Пропустить показание",
    hint: "Отправить показание с номером на 1 больше ожидаемого — как будто неудобное показание «потерялось» (SequenceMismatch).",
  },
  {
    id: "impostor",
    label: "Подписать чужим ключом",
    hint: "Показание подписано ключом, который не закреплён за этой поставкой (InvalidSignature).",
  },
  {
    id: "record",
    label: "Подменить off-chain запись",
    hint: "Температура и подпись настоящие, но шлюз ссылается на другую off-chain запись. Подпись покрывает и её хэш, поэтому контракт отвергнет (InvalidSignature).",
  },
];

/**
 * In-browser IoT sensor + gateway. Signs readings with the demo sensor key and relays them
 * through the active role's wallet (anyone may relay — the signature is what counts).
 * The "tamper" modes show what the contract rejects and why.
 */
export function SensorPanel({ shipment, provider, signerContract, chainId, canAnchor, store, onRecord, run, isPending }) {
  const [tempC, setTempC] = useState(4.5);
  const [alteredC, setAlteredC] = useState(5.0);
  const [tamper, setTamper] = useState("none");
  const [profile, setProfile] = useState("spike");
  const [auto, setAuto] = useState(false);
  const [intervalMs, setIntervalMs] = useState(3000);
  const [anchoredCount, setAnchoredCount] = useState(0);
  const [lastSigned, setLastSigned] = useState(null);
  // Records collected since the last anchor.
  const batch = store.slice(anchoredCount);
  const autoIndex = useRef(0);
  const busy = useRef(false);

  async function submit(celsius, mode) {
    if (busy.current) return;
    busy.current = true;
    try {
      // Re-read the shipment right before signing: sequence numbers must be gap-free.
      const [fresh, latest] = await Promise.all([signerContract.getShipment(shipment.id), provider.getBlock("latest")]);
      const expectedSeq = Number(fresh.readingCount);
      const sequence = mode === "skip" ? expectedSeq + 1 : expectedSeq;
      const timestamp = nextTimestamp({
        chainNow: latest.timestamp,
        lastReadingAt: fresh.lastReadingAt,
        startedAt: fresh.startedAt,
      });
      const signedTemp = toDeci(celsius);
      const key = mode === "impostor" ? IMPOSTOR_WALLET : SENSOR_WALLET;
      // The sensor signs the reading AND the hash of the full off-chain record together.
      const { record, telemetryHash } = buildMeasurement({
        shipmentId: shipment.id,
        sequence,
        temperature: signedTemp,
        timestamp,
        deviceId: DEMO_DEVICE_ID,
      });
      const signature = await signReading(key, {
        chainId,
        contractAddress: CONTRACT_ADDRESS,
        shipmentId: shipment.id,
        sequence,
        temperature: signedTemp,
        timestamp,
        telemetryHash,
      });
      const sentTemp = mode === "alter" ? toDeci(alteredC) : signedTemp;
      const sentHash = mode === "record" ? telemetryRecordHash({ ...record, temperature: toDeci(alteredC) }) : telemetryHash;
      setLastSigned({ sequence, timestamp, signedTemp, sentTemp, telemetryHash, sentHash, signer: key.address, signature });

      const label =
        mode === "none" ? `Показание #${sequence} (${formatTemp(sentTemp)})` : `Показание #${sequence} [${modeLabel(mode)}]`;
      const receipt = await run(label, () =>
        signerContract.submitReading(shipment.id, sequence, sentTemp, timestamp, sentHash, signature),
      );
      // The off-chain store only gets the record the chain actually accepted.
      if (receipt) onRecord(record);
    } finally {
      busy.current = false;
    }
  }

  async function anchor() {
    const dataHash = telemetryBatchHash(batch);
    const receipt = await run(`Якорь батча из ${batch.length} записей`, () =>
      signerContract.anchorTelemetry(shipment.id, dataHash, batch[0].measuredAt, batch.at(-1).measuredAt),
    );
    if (receipt) setAnchoredCount(store.length);
  }

  useEffect(() => {
    if (!auto) return undefined;
    const tick = () => {
      const c = temperatureAt(autoIndex.current, { profile });
      autoIndex.current += 1;
      setTempC(Number(c.toFixed(1)));
      submit(c, "none");
    };
    tick();
    const timer = setInterval(tick, intervalMs);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, intervalMs, profile]);

  const mode = TAMPER_MODES.find((m) => m.id === tamper);

  return (
    <Card title="Датчик и шлюз" className="sensor" aside={<code className="muted small">ключ датчика {SENSOR_WALLET.address.slice(0, 10)}…</code>}>
      <div className="sensor-grid">
        <div>
          <label className="slider-label">
            Температура датчика: <strong>{tempC.toFixed(1)} °C</strong>
            <input
              type="range"
              min={TEMP_MIN_C}
              max={TEMP_MAX_C}
              step="0.1"
              value={tempC}
              onChange={(e) => setTempC(Number(e.target.value))}
              disabled={auto}
            />
          </label>
          <div className="muted small">
            Допустимо {formatTemp(shipment.minTemp)} … {formatTemp(shipment.maxTemp)}
            {toDeci(tempC) < shipment.minTemp || toDeci(tempC) > shipment.maxTemp ? " — сейчас вне диапазона" : ""}
          </div>

          <fieldset className="tamper">
            <legend>Поведение шлюза</legend>
            {TAMPER_MODES.map((m) => (
              <label key={m.id} className="radio">
                <input type="radio" name="tamper" value={m.id} checked={tamper === m.id} onChange={() => setTamper(m.id)} disabled={auto} />
                {m.label}
              </label>
            ))}
            {tamper === "alter" || tamper === "record" ? (
              <label className="inline">
                Отправить вместо подписанного:
                <input type="number" step="0.1" value={alteredC} onChange={(e) => setAlteredC(Number(e.target.value))} />
                °C
              </label>
            ) : null}
            <p className="muted small">{mode.hint}</p>
          </fieldset>

          <button type="button" className="btn btn-primary" disabled={isPending || auto} onClick={() => submit(tempC, tamper)}>
            Подписать и отправить показание
          </button>
        </div>

        <div>
          <fieldset className="auto">
            <legend>Автоматический режим</legend>
            <label className="inline">
              Профиль
              <select value={profile} onChange={(e) => setProfile(e.target.value)} disabled={auto}>
                <option value="normal">normal — стабильно ~4.5 °C</option>
                <option value="spike">spike — всплеск до 12.7 °C на 5–6-м показании</option>
              </select>
            </label>
            <label className="inline">
              Интервал
              <select value={intervalMs} onChange={(e) => setIntervalMs(Number(e.target.value))} disabled={auto}>
                {INTERVAL_OPTIONS.map((ms) => (
                  <option key={ms} value={ms}>
                    {ms / 1000} с
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className={`btn ${auto ? "btn-danger" : "btn-secondary"}`}
              onClick={() => {
                if (!auto) autoIndex.current = 0;
                setAuto(!auto);
              }}
            >
              {auto ? "Остановить датчик" : "Запустить датчик"}
            </button>
          </fieldset>

          <fieldset className="anchor">
            <legend>Якорение off-chain батча</legend>
            <p className="muted small">
              Помимо показаний в цепочку периодически пишется общий хэш батча off-chain записей. Не заякорено: {batch.length}.
            </p>
            <button type="button" className="btn btn-secondary" disabled={isPending || batch.length === 0 || !canAnchor} onClick={anchor}>
              Заякорить хэш батча
            </button>
            {!canAnchor ? <span className="muted small"> Якорить могут только перевозчик и производитель.</span> : null}
          </fieldset>
        </div>
      </div>

      {lastSigned ? (
        <Notice tone={lastSigned.sentTemp === lastSigned.signedTemp && lastSigned.sentHash === lastSigned.telemetryHash ? "info" : "warning"}>
          <div className="signed">
            <div>
              Подписано: #{lastSigned.sequence}, {formatTemp(lastSigned.signedTemp)}, ts {lastSigned.timestamp}, ключ{" "}
              <code>{lastSigned.signer.slice(0, 10)}…</code>
            </div>
            <div className="muted small">
              off-chain запись <code>{lastSigned.telemetryHash.slice(0, 18)}…</code>
            </div>
            {lastSigned.signedTemp !== lastSigned.sentTemp ? (
              <div>
                Отправлено в контракт: <strong>{formatTemp(lastSigned.sentTemp)}</strong> — подпись к этим данным не подходит.
              </div>
            ) : null}
            {lastSigned.sentHash !== lastSigned.telemetryHash ? (
              <div>
                Ссылка на off-chain запись подменена на <code>{lastSigned.sentHash.slice(0, 18)}…</code> — подпись
                покрывает и хэш записи, поэтому она больше не сходится.
              </div>
            ) : null}
            <div className="muted small">
              signature <code>{lastSigned.signature.slice(0, 22)}…</code>
            </div>
          </div>
        </Notice>
      ) : null}
    </Card>
  );
}

function modeLabel(mode) {
  return TAMPER_MODES.find((m) => m.id === mode)?.label ?? mode;
}
