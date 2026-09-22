# Cold Chain Monitoring

Блокчейн-система мониторинга холодовой цепи поставок: смарт-контракт `ColdChain` хранит условия поставки,
принимает подписанные IoT-датчиком показания температуры, неизменяемо фиксирует нарушения и автоматически
рассчитывает выплату перевозчику; веб-интерфейс в `frontend/` показывает эти механизмы в работе от лица трёх
участников и эмулирует датчик прямо в браузере.

## Стек

- Solidity 0.8.37 (та же версия, что в контейнере `ghcr.io/argotorg/solc:stable`), OpenZeppelin 5 (ECDSA)
- Hardhat 3 + ethers v6 + mocha/chai — компиляция, локальная сеть, тесты
- Frontend: React 19 + Vite 7 + ethers v6, vitest + Testing Library (папка `frontend/`)
- Node.js ≥ 22 (ESM)

## Быстрый старт

```bash
npm install
npm test                 # 64 теста
npm run coverage         # покрытие ColdChain.sol — 100 %
npm run demo             # сквозной сценарий из §9 документации на in-process сети
```

Работа с отдельной нодой и веб-интерфейсом:

```bash
npm run node             # терминал 1: JSON-RPC на http://127.0.0.1:8545, chainId 31337
npm run deploy           # терминал 2: деплой → deployments/localhost.json (адрес + ABI)
npm run frontend:install # один раз
npm run frontend         # терминал 3: http://localhost:5173
```

Дополнительно, без UI:

```bash
npm run shipment         # создать поставку #N и принять её перевозчиком
SHIPMENT_ID=1 PROFILE=spike npm run gateway   # CLI-эмулятор датчика/шлюза (UI подхватит его показания по событиям)
npm run demo:localhost   # сквозной сценарий против ноды
```

Аудит off-chain хранилища (шлюз пишет его в `telemetry/<сеть>-shipment-<id>.json`):

```bash
SHIPMENT_ID=1 npm run verify                  # сверить хранилище с блокчейном
SHIPMENT_ID=1 TAMPER=4:4.5 npm run verify     # сначала подменить запись #4 — и увидеть, как это вскроется
```

После перезапуска ноды деплой нужно повторить (`npm run deploy`) — интерфейс сам подскажет это баннером.

Сборка контейнерным компилятором (ABI + bytecode в `build-solc/`, те же настройки, что у Hardhat):

```bash
npm run compile:docker
```

## Модель контракта `ColdChain`

Датчик сначала попадает в реестр (`registerSensor`), и только зарегистрированному активному устройству
можно назначить поставку:

```
registerSensor(registrar) ──▶ SensorRecord{deviceIdHash, active}
                                     │ (требуется в createShipment)
                                     ▼
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
| `registerSensor(sensor, deviceIdHash)` | Sensor registrar | Ставит ключ датчика в реестр; без этого его нельзя назначить поставке |
| `setSensorActive(sensor, active)` | Sensor registrar | Вывод из эксплуатации / возврат; на уже созданные поставки не влияет |
| `setRegistrar(account, allowed)` | Admin (деплоер) | Выдаёт и отзывает право вести реестр |
| `createShipment(product, carrier, receiver, sensor, minTemp, maxTemp, penaltyBps)` `payable` | Manufacturer | Создаёт поставку для зарегистрированного датчика, депонирует `msg.value` (escrow) |
| `cancelShipment(id)` | Manufacturer | Отмена до принятия перевозчиком, escrow возвращается |
| `startTransit(id)` | Carrier | Принятие условий, начало мониторинга |
| `submitReading(id, sequence, temperature, timestamp, telemetryHash, signature)` | Любой relay (шлюз) | Показание и хэш off-chain записи, подписанные ключом датчика вместе; вне диапазона → `TemperatureViolation` + `COMPROMISED` |
| `anchorTelemetry(id, hash, from, to)` | Carrier / Manufacturer | Якорит хэш off-chain батча телеметрии |
| `confirmDelivery(id)` | Receiver | Завершение; расчёт выплат по правилу, зафиксированному при создании |
| `settleExpired(id)` | Carrier / Manufacturer | Расчёт, если получатель не подтвердил доставку за `SETTLEMENT_TIMEOUT` (30 дней) — escrow не может зависнуть навсегда. Штраф удерживается **всегда**: подтверждения доставки нет |
| `withdraw()` | Carrier / Manufacturer | Забрать начисленное (pull-payment) |
| `getShipment / getViolations / getAnchors / getSensor / isSensorActive / previewSettlement / previewExpiredSettlement / hasTemperatureViolation / readingDigest` | view | Данные для фронтенда |

Ключевые решения:

- **Температура** — `int32` в десятых долях °C (`2.0°C == 20`), чтобы не использовать дробные числа в EVM.
- **Реестр датчиков.** Поставку можно назначить только зарегистрированному и активному устройству
  (`SensorNotRegistered` / `SensorInactive`). В цепи хранится `deviceIdHash` — обязательство к off-chain паспорту
  устройства (серийный номер, модель, сертификат поверки). Вывод датчика из эксплуатации действует только вперёд:
  уже идущие поставки продолжают работать, чтобы регистратор не мог задним числом сломать чужую поставку.
- **Подпись датчика.** Показание подписывается EIP-191 (`personal_sign`) над
  `keccak256(abi.encode(chainId, contract, shipmentId, sequence, temperature, timestamp, telemetryHash))`. Контракт
  восстанавливает подписанта и сравнивает с `sensor` поставки. Отправлять транзакцию может кто угодно —
  аутентифицирует данные подпись, а не `msg.sender`. Перевозчик не может «исправить» 12.7°C на 5.2°C: подпись перестанет сходиться.
- **Без пропусков.** Датчик нумерует показания; контракт требует `sequence == readingCount` (`SequenceMismatch`).
  Перевозчик не может «потерять» показание с нарушением и передать следующее нормальное — цепочка показаний либо полная,
  либо обрывается, и обрыв виден всем участникам.
- **Защита от повтора.** Таймстампы датчика строго возрастают (`StaleReading`), не раньше `startedAt` и не дальше
  `block.timestamp + 15 min` (`ReadingFromFuture`). Дайджест привязан к chainId и адресу контракта.
- **Финансовое правило.** `penaltyBps` (базисные пункты) фиксируется при создании. Если штраф применяется —
  перевозчику `payment × (1 − penalty)`, производителю возврат `payment × penalty`. Выплаты — pull-паттерн (`pendingWithdrawals` + `withdraw()`).
  Штраф применяется при `violationCount > 0` (неизменяемый факт, а не текущий статус) **или** при расчёте через
  `settleExpired`. Последнее — потому что подтвердить факт доставки может только получатель; его молчание не является
  доказательством успеха, а «ноль нарушений» перевозчик, управляющий шлюзом, получает простым сокрытием телеметрии.
  Так скрывать показания становится не выгоднее, чем честно передать нарушение.
- **On-chain / off-chain.** Каждое показание попадает в событие `ReadingSubmitted` (дёшево, фронтенд читает историю по логам),
  в storage пишутся только нарушения и якоря хэшей батчей.
- **Целостность off-chain данных.** Полная запись измерения (идентификатор устройства, время, температура и прочие
  данные датчика) хранится вне цепи, а её хэш (`telemetryHash`) входит в подписываемый датчиком дайджест
  и публикуется в `ReadingSubmitted`. Хэш считается от канонического JSON (ключи отсортированы), чтобы не зависеть
  от порядка полей. Поэтому любую правку хранилища можно доказать: пересчёт хэша не сойдётся с обязательством
  в цепи, а обязательство подписано самим датчиком — значит изменилось именно хранилище
  (см. `scripts/verify-telemetry.js` и карточку «Off-chain хранилище телеметрии» в UI).

События: `SensorRegistered`, `SensorActiveSet`, `RegistrarSet`, `ShipmentCreated`, `ShipmentStarted`,
`ReadingSubmitted`, `TemperatureViolation`, `TelemetryAnchored`, `ShipmentDelivered`, `ShipmentExpired`,
`ShipmentCancelled`, `Withdrawal`.

## Структура

```
contracts/ColdChain.sol              контракт
contracts/test/RejectingManufacturer.sol  мок для теста отказа перевода
test/ColdChain.test.js               mocha-тесты (fixtures, custom errors, балансы)
scripts/deploy.js                    деплой + запись deployments/<network>.json
scripts/demo.js                      сквозной сценарий (create → violation → settlement)
scripts/create-shipment.js           CLI: создать поставку на ноде
scripts/sensor-gateway.js            эмулятор IoT-датчика + шлюза (подпись, relay, якорение, запись off-chain)
scripts/verify-telemetry.js          аудит off-chain хранилища против цепи (+ режим TAMPER)
scripts/compile-docker.js            сборка через ghcr.io/argotorg/solc:stable
scripts/lib/sensor.js                каноническая запись, хэши, readingDigest / signReading, verifyTelemetry
scripts/lib/telemetry-store.js       файловое off-chain хранилище telemetry/*.json (вместо БД)
scripts/lib/accounts.js              ключ демо-датчика (hardhat account #9), его deviceId, SENSOR_PRIVATE_KEY
scripts/lib/deployment.js            чтение/запись deployments/*.json
frontend/src/lib/                    chain (provider, ABI, мапперы), roles (ключи демо-ролей), sensor, errors, format
frontend/src/hooks/                  useChain (опрос блоков), useShipments (список/детали/балансы/реестр), useTransaction
frontend/src/components/             RoleSwitcher, CreateShipmentForm, SensorRegistry, ShipmentDetails, SensorPanel,
                                     TelemetryAudit, TemperatureChart, EventLog…
```

## Фронтенд (`frontend/`)

Один экран, три роли. В шапке — переключатель «Производитель / Перевозчик / Получатель»: это Hardhat-аккаунты #1–#3,
ключи которых живут в странице (только для локальной сети), поэтому демонстрация идёт в одном окне без MetaMask.
Рядом с каждой ролью — баланс ETH и сумма «к выводу» с кнопкой `withdraw()`.

Что показывает интерфейс:

- **Реестр датчиков**: статус демо-устройства, его `deviceIdHash`, кнопки регистрации и вывода из эксплуатации
  (подписывает регистратор — аккаунт #0). После вывода создать поставку с этим датчиком уже нельзя.
- **Список поставок и форма создания** (для производителя): диапазон температур, escrow в ETH, штраф в %.
  Валидация повторяет проверки контракта, чтобы ошибка была видна до отправки транзакции.
- **Карточка поставки**: условия, статус, `previewSettlement` — сколько получит перевозчик и что вернётся
  производителю, если завершить сейчас; после завершения — итог из события `ShipmentDelivered`/`ShipmentExpired`.
- **Действия по роли**: `startTransit`, `cancelShipment`, `confirmDelivery`, `settleExpired` (с обратным отсчётом
  30 дней). Кнопки показываются только тем, кому контракт разрешит вызов, а отказ контракта декодируется в
  понятное сообщение (`Unauthorized`, `InvalidStatus`, `InvalidSignature`, `SequenceMismatch`, …).
- **График температуры** по событиям `ReadingSubmitted` с полосой допустимого диапазона и маркерами нарушений,
  таблица показаний с номером блока и хэшем транзакции.
- **Панель «Датчик и шлюз»** (пока поставка активна): слайдер температуры, ручная отправка и автоматический режим
  (профили `normal` / `spike`, как в CLI-шлюзе), якорение хэша батча. Режимы нечестного шлюза показывают, что
  именно отвергает контракт: подмена температуры после подписи и чужой ключ → `InvalidSignature`,
  пропуск показания → `SequenceMismatch`.
- **Предупреждение о телеметрии**: если показаний нет или поток оборвался (>15 мин), карточка явно говорит об
  этом — это документированный пробел MVP (контракт не требует минимума показаний), и получатель должен видеть его
  до `confirmDelivery`.
- **История в блокчейне**: все события поставки с номером блока и tx-хэшем — неизменяемый журнал.

Технически: `frontend/src/lib/chain.js` берёт адрес и ABI из `deployments/localhost.json`, подпись показаний
переиспользует `scripts/lib/sensor.js` (тот же код, что у CLI-шлюза). Состояние перечитывается при появлении нового
блока (опрос `eth_blockNumber` раз в секунду). Тесты: `npm run frontend:test` — 47 тестов, включая сквозной сценарий
на in-memory заглушке контракта; покрытие ~93 %.

## Известные ограничения

- **Полный отказ от телеметрии.** Перевозчик может вовсе не передавать показания (или остановить передачу до нарушения) —
  контракт не требует минимального числа показаний для расчёта. Обрыв истории виден on-chain (`readingCount`, отсутствие
  `ReadingSubmitted`), и получатель видит это до `confirmDelivery`, но автоматической санкции нет: для этого нужна логика
  споров/арбитража. Фронтенд должен явно показывать предупреждение «телеметрия отсутствует/оборвана».
  Частично закрыто в `settleExpired`: без подтверждения получателя штраф удерживается даже при нулевом `violationCount`,
  поэтому молчание перевозчику выгоднее честного нарушения не делает. Но при `confirmDelivery` получатель по-прежнему
  подтверждает доставку «на глаз» — полноценный арбитраж вне MVP.
- `anchorTelemetry` — только аудиторский след (хэш off-chain батча), в расчёте выплат не участвует.
  Целостность отдельных записей обеспечивает `telemetryHash` в каждом показании, якорь же даёт одно
  обязательство на целый батч сразу.
- **Хранилище телеметрии — файл, а не БД.** Для учебного проекта этого достаточно: схема доказательства
  не зависит от того, где лежат данные — важно лишь, что хранилищу не доверяют. Замена на PostgreSQL или
  любую другую БД не потребует изменений ни в контракте, ни в логике аудита.
- Компрометация физического датчика (реестр доказывает происхождение ключа, но не то, что устройство измерило
  правду), несколько датчиков на поставку, оплата ERC-20, деплой в публичную сеть.
