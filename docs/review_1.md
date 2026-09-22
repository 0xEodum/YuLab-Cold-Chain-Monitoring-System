| Приоритет               | Наблюдение                                                           | Почему важно                                                                                               |
| ----------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **Высокий**             | `settleExpired()` может выплатить Carrier 100% без Receiver          | Если telemetry была скрыта полностью, через 30 дней отсутствие violations трактуется как успешная поставка |
| **Высокий**             | Нет Sensor Registry                                                  | Любой Manufacturer может указать произвольный `sensor` при создании shipment                               |
| **Высокий**             | `telemetryHash` не входит в подписанное measurement                  | Нет криптографической связи между sensor-signed measurement и заявленной off-chain записью                 |
| **Средний**             | Нет PostgreSQL/Gateway API                                           | Поэтому сценарий «испортить DB и обнаружить изменение по blockchain hash» пока фактически не реализован    |
| **Средний**             | `sequence == readingCount`, а не `sequence > lastSequence`           | Отлично показывает пропуск, но потеря одного настоящего сообщения навсегда блокирует все следующие         |
| **Средний**             | `previewSettlement()` после delivery может показывать неверный split | После `COMPROMISED → DELIVERED` статус больше не COMPROMISED, поэтому preview вернёт 100% Carrier          |
| **Низкий/согласование** | 0.1°C вместо 0.001°C, EIP-191 вместо EIP-712                         | Не обязательно плохо, но это расходится с Technical Specification                                          |

Самая существенная логическая проблема — `settleExpired()` (`ColdChain.sol:317–329`). Я понимаю, зачем он появился: без него Receiver может навсегда заблокировать escrow. Но теперь возникает обратная проблема.

Представим Carrier, который контролирует передачу telemetry. Он вообще не отправляет плохие показания. В blockchain остаётся `violationCount == 0`. Receiver не подтверждает получение. Через 30 дней Carrier вызывает `settleExpired()` и получает всю сумму.

Получается сочетание двух известных особенностей системы: **gateway может скрыть последнее/все measurements + отсутствие violations считается успешным результатом**. В первоначальной спецификации такой timeout settlement отсутствовал, и это было безопаснее относительно заявленной бизнес-модели. 


### Sensor registry действительно стоит вернуть

В Technical Specification есть отдельный FR-01: sensor сначала регистрируется, имеет `deviceIdHash` и `active`, а неавторизованный sensor нельзя назначить shipment. 

Сейчас `createShipment()` на строках 169–201 просто получает произвольный:

```solidity
address sensor
```

и проверяет только `sensor != address(0)`.

Из-за этого тест:

`"rejects a reading signed by an unregistered key"`

назван немного вводяще в заблуждение. Контракт отклоняет **не тот ключ, который записан в shipment**, но понятия registered/unregistered sensor в нём сейчас вообще нет.

Я бы добавил небольшой registry с `active` + `deviceIdHash`, роль `SENSOR_REGISTRAR_ROLE` и проверку `require(sensor.active)` внутри `createShipment()`. Это не сильно увеличит контракт, но приведёт trust model обратно к ТЗ.

### Самое заметное расхождение с hybrid on-chain/off-chain архитектурой

В спецификации measurement содержит:

```text
shipmentId
temperatureMilliC
measuredAt
sequence
telemetryHash
sensorSignature
```

и `telemetryHash` должен быть частью подписываемых данных. 

Cейчас sensor подписывает только:

```text
chainId
contract
shipmentId
sequence
temperature
timestamp
```

А batch hash потом отдельно формирует Gateway и вызывает `anchorTelemetry()`.

Это означает, что Sensor подтверждает температуру, но **не подтверждает соответствующую off-chain telemetry record**. Более того, текущий batch hash считается через `JSON.stringify([{timestamp, temperature}, ...])`; туда не входят даже signature и sequence.


### Есть ещё один конкретный контрактный footgun

В `previewSettlement()`:

```solidity
if (s.status == Status.COMPROMISED) {
    manufacturerRefund = ...
}
```

После доставки compromised shipment становится `DELIVERED`. Следовательно, `previewSettlement()` после settlement начнёт утверждать, что Carrier должен был получить 100%.

Frontend уже знает об этой проблеме и специально извлекает настоящий итог из `ShipmentDelivered`/`ShipmentExpired`. Это хороший workaround, но API контракта остаётся неожиданным для любого другого клиента.

Простейшее исправление — рассчитывать по неизменяемому факту:

```solidity
if (s.violationCount > 0) {
    ...
}
```

или вернуть предусмотренный ТЗ `hasTemperatureViolation`.
