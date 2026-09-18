# Cold Chain Monitoring — Blockchain backend

Smart-contract бэкенд прототипа из [проектной документации](./Blockchain-based%20Cold%20Chain%20Monitoring%20System%20—%20Project%20Documentation.md):
контракт `ColdChain` хранит условия поставки, принимает подписанные IoT-датчиком показания температуры,
неизменяемо фиксирует нарушения и автоматически рассчитывает выплату перевозчику.

## Стек

- Solidity 0.8.37 (та же версия, что в контейнере `ghcr.io/argotorg/solc:stable`), OpenZeppelin 5 (ECDSA)
- Hardhat 3 + ethers v6 + mocha/chai — компиляция, локальная сеть, тесты
- Node.js ≥ 22 (ESM)

## Быстрый старт

```bash
npm install
npm test                 # 51 тест
npm run coverage         # покрытие ColdChain.sol — 100 %
npm run demo             # сквозной сценарий из §9 документации на in-process сети
```

Работа с отдельной нодой (так к контракту будет подключаться фронтенд):

```bash
npm run node             # терминал 1: JSON-RPC на http://127.0.0.1:8545, chainId 31337
npm run deploy           # терминал 2: деплой → deployments/localhost.json (адрес + ABI)
npm run shipment         # создать поставку #N и принять её перевозчиком
SHIPMENT_ID=1 PROFILE=spike npm run gateway   # эмулятор датчика/шлюза: подписывает и шлёт показания
npm run demo:localhost   # тот же сквозной сценарий, но против ноды
```

Сборка контейнерным компилятором (ABI + bytecode в `build-solc/`, те же настройки, что у Hardhat):

```bash
npm run compile:docker
```

## Модель контракта `ColdChain`

```
CREATED ──startTransit(carrier)──▶ IN_TRANSIT ──violation──▶ COMPROMISED
   │                                    │                         │
   │                                    ├────confirmDelivery(receiver)────▶ DELIVERED
   │                                    │
   │                                    └──settleExpired(carrier|manufacturer, после 30 дней)──▶ EXPIRED
   │
   └─cancelShipment(manufacturer)──▶ CANCELLED
```

| Функция | Кто | Что делает |
|---|---|---|
| `createShipment(product, carrier, receiver, sensor, minTemp, maxTemp, penaltyBps)` `payable` | Manufacturer | Создаёт поставку, депонирует `msg.value` (escrow) |
| `cancelShipment(id)` | Manufacturer | Отмена до принятия перевозчиком, escrow возвращается |
| `startTransit(id)` | Carrier | Принятие условий, начало мониторинга |
| `submitReading(id, sequence, temperature, timestamp, signature)` | Любой relay (шлюз) | Показание, подписанное ключом датчика; вне диапазона → `TemperatureViolation` + `COMPROMISED` |
| `anchorTelemetry(id, hash, from, to)` | Carrier / Manufacturer | Якорит хэш off-chain батча телеметрии |
| `confirmDelivery(id)` | Receiver | Завершение; расчёт выплат по правилу, зафиксированному при создании |
| `settleExpired(id)` | Carrier / Manufacturer | Тот же расчёт, если получатель не подтвердил доставку за `SETTLEMENT_TIMEOUT` (30 дней) — escrow не может зависнуть навсегда |
| `withdraw()` | Carrier / Manufacturer | Забрать начисленное (pull-payment) |
| `getShipment / getViolations / getAnchors / previewSettlement / readingDigest` | view | Данные для фронтенда |

Ключевые решения:

- **Температура** — `int32` в десятых долях °C (`2.0°C == 20`), чтобы не использовать дробные числа в EVM.
- **Подпись датчика.** Показание подписывается EIP-191 (`personal_sign`) над
  `keccak256(abi.encode(chainId, contract, shipmentId, sequence, temperature, timestamp))`. Контракт восстанавливает
  подписанта и сравнивает с `sensor`, зарегистрированным при создании поставки. Отправлять транзакцию может кто угодно —
  аутентифицирует данные подпись, а не `msg.sender`. Перевозчик не может «исправить» 12.7°C на 5.2°C: подпись перестанет сходиться.
- **Без пропусков.** Датчик нумерует показания; контракт требует `sequence == readingCount` (`SequenceMismatch`).
  Перевозчик не может «потерять» показание с нарушением и передать следующее нормальное — цепочка показаний либо полная,
  либо обрывается, и обрыв виден всем участникам.
- **Защита от повтора.** Таймстампы датчика строго возрастают (`StaleReading`), не раньше `startedAt` и не дальше
  `block.timestamp + 15 min` (`ReadingFromFuture`). Дайджест привязан к chainId и адресу контракта.
- **Финансовое правило.** `penaltyBps` (базисные пункты) фиксируется при создании. При `COMPROMISED`:
  перевозчику `payment × (1 − penalty)`, производителю возврат `payment × penalty`. Выплаты — pull-паттерн (`pendingWithdrawals` + `withdraw()`).
- **On-chain / off-chain.** Каждое показание попадает в событие `ReadingSubmitted` (дёшево, фронтенд читает историю по логам),
  в storage пишутся только нарушения и якоря хэшей батчей.

События: `ShipmentCreated`, `ShipmentStarted`, `ReadingSubmitted`, `TemperatureViolation`, `TelemetryAnchored`,
`ShipmentDelivered`, `ShipmentExpired`, `ShipmentCancelled`, `Withdrawal`.

## Структура

```
contracts/ColdChain.sol              контракт
contracts/test/RejectingManufacturer.sol  мок для теста отказа перевода
test/ColdChain.test.js               mocha-тесты (fixtures, custom errors, балансы)
scripts/deploy.js                    деплой + запись deployments/<network>.json
scripts/demo.js                      сквозной сценарий (create → violation → settlement)
scripts/create-shipment.js           CLI: создать поставку на ноде
scripts/sensor-gateway.js            эмулятор IoT-датчика + шлюза (подпись, relay, якорение)
scripts/compile-docker.js            сборка через ghcr.io/argotorg/solc:stable
scripts/lib/sensor.js                readingDigest / signReading / hash батча (зеркало контракта)
scripts/lib/accounts.js              ключ демо-датчика (hardhat account #9), SENSOR_PRIVATE_KEY
scripts/lib/deployment.js            чтение/запись deployments/*.json
```

## Для фронтенда

- Адрес и ABI: `deployments/localhost.json` (адрес детерминирован: `0x5FbDB2315678afecb367f032d93F642f64180aa3` при свежей ноде).
- Роли — стандартные аккаунты Hardhat: `#1` manufacturer, `#2` carrier, `#3` receiver, `#9` — ключ демо-датчика
  (см. `scripts/lib/accounts.js`; это публичные тестовые ключи, только для локальной сети).
- История поставки: `getShipment`, `getViolations`, `getAnchors` + фильтр событий `ReadingSubmitted(shipmentId)`.
- Расчёт выплат до завершения: `previewSettlement(id)`.
- Ошибки контракта — custom errors (`Unauthorized`, `InvalidStatus`, `InvalidSignature`, …), их удобно декодировать через `interface.parseError`.

## Известные ограничения (осознанно за рамками MVP)

- **Полный отказ от телеметрии.** Перевозчик может вовсе не передавать показания (или остановить передачу до нарушения) —
  контракт не требует минимального числа показаний для расчёта. Обрыв истории виден on-chain (`readingCount`, отсутствие
  `ReadingSubmitted`), и получатель видит это до `confirmDelivery`, но автоматической санкции нет: для этого нужна логика
  споров/арбитража. Фронтенд должен явно показывать предупреждение «телеметрия отсутствует/оборвана».
- `anchorTelemetry` — только аудиторский след (хэш off-chain батча), в расчёте выплат не участвует.
- Компрометация физического датчика, несколько датчиков на поставку, оплата ERC-20, деплой в публичную сеть.
