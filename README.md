# Discord Webhook Delivery Module

Надёжный NestJS-модуль для асинхронной доставки событий в Discord Webhook при всплесках нагрузки, rate limit, `429`, сетевых сбоях и перезапуске приложения.

Проект сделан как самостоятельный backend-модуль, который можно подключить к другому NestJS-приложению и запустить локально одной Docker Compose-командой.

## Содержание

- [Зачем этот проект](#зачем-этот-проект)
- [Что гарантирует система](#что-гарантирует-система)
- [Быстрый запуск](#быстрый-запуск)
- [Проверка после запуска](#проверка-после-запуска)
- [Архитектура](#архитектура)
- [Почему выбран этот стек](#почему-выбран-этот-стек)
- [Rate limiting и retry](#rate-limiting-и-retry)
- [Transactional outbox](#transactional-outbox)
- [Demo API](#demo-api)
- [Нагрузочное тестирование](#нагрузочное-тестирование)
- [Сценарии отказов](#сценарии-отказов)
- [Перезапуск и восстановление](#перезапуск-и-восстановление)
- [Конфигурация](#конфигурация)
- [Тесты проекта](#тесты-проекта)
- [Безопасность](#безопасность)
- [Trade-offs](#trade-offs)
- [Production considerations](#production-considerations)

## Зачем этот проект

Прямой HTTP-вызов Discord Webhook плохо подходит для большого потока событий:

- Discord разрешает около 2 запросов в секунду на канал;
- `429 Too Many Requests` нельзя считать окончательной ошибкой;
- сетевой timeout оставляет неоднозначный результат: Discord мог принять сообщение;
- один загруженный канал не должен задерживать другой;
- процесс может упасть между созданием события и фактической доставкой;
- некорректно составленный webhook (`400`) не должен создавать бесконечный retry loop.

Модуль разделяет эти ответственности:

```text
Business application
        |
        | durable enqueue
        v
PostgreSQL transactional outbox
        |
        | immediate publish + polling fallback
        v
BullMQ: discord-webhooks  <---->  Redis
        |
        | per-channel schedule + send permit (Redis Lua)
        v
Discord Webhook transport
        |
        +--> 2xx  -> delivered
        +--> 429  -> pause whole channel for Retry-After
        +--> 400  -> DLX
        +--> other / network error -> retry with backoff
```

Главная идея: очередь сама по себе не решает rate limit, а rate limiter сам по себе не решает durable delivery. BullMQ отвечает за jobs и scheduling, Redis за распределённую координацию, PostgreSQL за durable handoff, transport за Discord HTTP semantics.

## Что гарантирует система

### Гарантируется

- не более `2 webhook/sec` на каждый `channelId`, равномерно, даже при нескольких worker-инстансах;
- новое событие встаёт в конец уже зарезервированного расписания канала, а не уходит сразу;
- каналы независимы: ожидание одного канала не занимает worker-ы и не задерживает другой;
- Discord `429`: пауза всего канала на `Retry-After`, всё уже выданное расписание канала сдвигается на эту паузу;
- в DLX уходит только `400` (некорректный webhook), с логированием;
- все остальные ошибки (`401`, `403`, `404`, `5xx`, timeout, network) повторяются с exponential backoff + jitter, без потери события;
- delayed reschedule вместо удержания worker через `sleep`;
- событие сохраняется в PostgreSQL до публикации в BullMQ и публикуется сразу после записи;
- восстановление после падения приложения, publisher, worker или перезапуска Redis;
- at-least-once delivery semantics;
- логирование Discord `message.id`, если включён `DISCORD_WAIT_FOR_MESSAGE=true`.

### Не гарантируется

Exactly-once доставка в Discord невозможна через обычный HTTP Webhook без idempotency API на стороне Discord. Если Discord принял сообщение, но соединение оборвалось до ответа, retry может создать duplicate message.

Строгий порядок сообщений внутри канала тоже не гарантируется: события, которые ушли в retry после ошибки, встают в конец расписания.

## Быстрый запуск

### Требования

- Windows, macOS или Linux;
- Node.js 22+;
- npm;
- Docker Desktop с запущенным Docker Engine;
- тестовый Discord-сервер и webhook URL.

### 1. Создать `.env`

PowerShell:

```powershell
Copy-Item .env.example .env
notepad .env
```

macOS/Linux:

```bash
cp .env.example .env
${EDITOR:-nano} .env
```

Укажите реальные тестовые webhook URLs:

```env
DISCORD_WEBHOOK_A=https://discord.com/api/webhooks/...
DISCORD_WEBHOOK_B=https://discord.com/api/webhooks/...
```

`DISCORD_WEBHOOK_B` нужен для сценария двух независимых каналов.

### 2. Поднять инфраструктуру

Первый запуск или запуск после изменения кода:

```bash
docker compose up -d --build
```

Если менялся только `.env`:

```bash
docker compose up -d --force-recreate
```

Compose запускает:

- `app` на `http://localhost:3000`;
- Redis для BullMQ и rate limiter; с хоста доступен на `localhost:6380` (`REDIS_HOST_PORT`);
- PostgreSQL; с хоста доступен на `localhost:5444`.

Внутри Docker приложение подключается к `redis:6379` и `postgres:5432`. Таблица outbox создаётся приложением при старте.

### 3. Проверить контейнеры

```bash
docker compose ps
```

Ожидаются статусы:

```text
app       running
redis     healthy
postgres  healthy
```

## Проверка после запуска

Health endpoint проверяет оба persistence-компонента:

```bash
curl http://localhost:3000/health
```

Ожидаемый результат:

```json
{
  "status": "ok",
  "redis": "up",
  "postgres": "up"
}
```

Логи приложения:

```bash
docker compose logs -f app
```

Общий статус очередей:

```bash
curl http://localhost:3000/demo/queue-status
```

## Архитектура

```text
+----------------------+
| DemoController       |
| Business application |
+----------+-----------+
           |
           v
+----------------------+
| EnqueueWebhookService|
+----------+-----------+
           |  INSERT, затем trigger()
           v
+------------------------------+
| PostgreSQL Outbox            |
| pending -> publishing ->     |
| published                    |
+--------------+---------------+
               |
               v
+------------------------------+
| OutboxPublisher              |
| lease + SKIP LOCKED          |
+--------------+---------------+
               |
               v
+------------------------------+
| BullMQ discord-webhooks      |
+--------------+---------------+
               |
               v
+------------------------------+
| WebhookProcessor             |
| concurrency configurable     |
+------+-----------------------+
       |
       +--> RateLimiterService (Redis Lua, per channel)
       |
       +--> DiscordWebhookTransport
       |
       +--> DiscordResponseClassifier
       |
       +--> DLX discord-webhooks-dlx
```

### Основные границы ответственности

| Компонент                   | Ответственность                                                  |
| --------------------------- | ---------------------------------------------------------------- |
| `EnqueueWebhookService`     | Сохранить событие в outbox и сразу запустить публикацию          |
| `OutboxRepository`          | Схема, insert, lease, retry и published state                    |
| `OutboxPublisher`           | Перенести outbox event в BullMQ; polling как страховка           |
| BullMQ                      | Durable jobs, delayed scheduling и worker coordination           |
| `RateLimiterService`        | Расписание канала, разрешение на отправку, пауза канала по `429` |
| `WebhookProcessor`          | State machine доставки                                           |
| `DiscordWebhookTransport`   | HTTP request, headers и response body                            |
| `DiscordResponseClassifier` | `2xx`, `429`, `400` и retryable ответы                           |
| DLX                         | Полный envelope некорректного события                            |

## Почему выбран этот стек

### Почему BullMQ

BullMQ уже решает нужные задачи:

- durable jobs в Redis;
- delayed jobs;
- worker concurrency;
- recovery после worker crash;
- coordination нескольких worker-инстансов;
- понятные queue metrics.

Kafka здесь избыточна: проекту не нужна event-streaming платформа и replay log на огромных объёмах. RabbitMQ возможен, но добавил бы ещё один инфраструктурный компонент, а per-channel rate limiter всё равно пришлось бы реализовывать отдельно.

### Почему Redis

Redis используется сразу для двух связанных задач:

1. BullMQ backend.
2. Распределённое состояние rate limiter.

Lua script выполняет check-and-reserve атомарно. Поэтому Worker A и Worker B не смогут одновременно забрать один и тот же слот одного канала или отправить в канал чаще лимита.

### Почему не BullMQ global limiter

Глобальный limiter ограничил бы всю queue:

```text
A + B <= 2/sec
```

Нам требуется:

```text
A <= 2/sec
B <= 2/sec
```

Поэтому queue одна, а limiter разделён по `channelId`.

### Почему не queue-per-channel

Queue на каждый Discord channel создаёт лишнюю инфраструктурную динамику:

- нужно создавать и удалять queues;
- сложнее мониторинг;
- сложнее lifecycle;
- больше Redis keys и operational overhead.

Одна queue с `channelId` в payload проще и масштабируется понятнее.

### Почему PostgreSQL outbox

Без outbox есть опасное окно:

```text
DB transaction COMMIT
queue.add() fails
=> бизнес-данные сохранены, webhook event потерян
```

С outbox событие сначала надёжно записывается в PostgreSQL, а в очередь попадает асинхронно:

```text
outbox INSERT (COMMIT)
        |
        v
publisher: сразу после INSERT + polling раз в секунду
        |
        v
      BullMQ
```

Если publisher упал, запись остаётся в PostgreSQL и будет обработана после lease expiration.

### Почему не `sleep`

`await sleep(5000)` внутри worker удерживает concurrency slot. При большом потоке это блокирует обработку других каналов.

Вместо этого job переводится в delayed state до своего слота. Worker освобождается, а зарезервированный слот хранится в данных job.

## Rate limiting и retry

### Расписание канала

По умолчанию:

```env
DISCORD_RATE_LIMIT_PER_SECOND=2
```

Каждое событие при первой обработке резервирует слот в расписании своего канала. Слоты идут с интервалом `1000 / DISCORD_RATE_LIMIT_PER_SECOND` мс:

```text
0ms
500ms
1000ms
1500ms
```

Состояние канала хранится в одном Redis hash `discord-webhook:channel:<channelId>`:

| Поле      | Значение                                     |
| --------- | -------------------------------------------- |
| `next`    | время следующего свободного слота            |
| `blocked` | до какого момента канал на паузе после `429` |
| `shift`   | суммарный сдвиг расписания из-за пауз        |
| `last`    | время последней фактической отправки в канал |

TTL ключа покрывает всё зарезервированное расписание плюс `DISCORD_RATE_LIMIT_CLEANUP_GRACE_MS`, поэтому поздний event не теряет хвост очереди, а ключ удаляется после простоя. Время берётся у Redis (`TIME`), а не у часов конкретного worker.

Пример: в `12:00:00` пришло 6 событий, они получают слоты `12:00:00.000 … 12:00:02.500`. Если в `12:00:01.200` приходит седьмое, оно встаёт после шестого, в `12:00:03.000`, а не уходит сразу.

### Разрешение на отправку

Перед HTTP-запросом worker атомарно получает разрешение (`acquireSendPermit`). Оно выдаётся, только если:

1. наступил слот события (с учётом сдвига после пауз);
2. канал не на паузе после `429`;
3. с прошлой отправки в канал прошло не меньше интервала.

Иначе job откладывается ровно на оставшееся время. Третье условие защищает от всплесков: если worker-ы отстали и несколько jobs канала проснулись после своих слотов, они всё равно уходят не чаще лимита.

Если слот job прошёл давно (больше интервала назад — например, приложение простаивало и накопился backlog), она не ждёт вместе с остальными опоздавшими, а в том же атомарном шаге получает новый слот в конце расписания. Так backlog из N событий снова раскладывается по слотам, а не просыпается разом N раз подряд.

`DISCORD_WORKER_CONCURRENCY=10` не заменяет rate limit. Concurrency — сколько jobs обрабатывается одновременно, rate limit — сколько отправок разрешено за интервал.

### Discord `429`

При `429` processor:

1. читает `retry_after` из body (секунды), иначе заголовок `Retry-After` (секунды);
2. ставит паузу на весь `channelId`: пока пауза не закончилась, ни одна job этого канала не получит разрешение на отправку;
3. сдвигает на длительность паузы всё уже выданное расписание канала, сохраняя интервал между слотами, поэтому после паузы канал продолжает в том же темпе, без дыр и без очереди из «проснувшихся» jobs;
4. откладывает текущую job, сохранив её слот;
5. не влияет на другие channels.

Чтобы 429 случался реже, processor читает и заголовки успешных ответов: если Discord вернул `X-RateLimit-Remaining: 0`, канал заранее ставится на паузу на `X-RateLimit-Reset-After` — так же, как при 429, но без неудачного запроса.

`429` — сигнал ожидания, а не ошибка события: он не расходует попытки и никогда не приводит в DLX.

### Остальные ошибки

Всё, кроме `2xx`, `400` и `429` — `401`, `403`, `404`, `5xx`, timeout и network errors — повторяется с exponential backoff и jitter:

```text
base delay
2 * base delay
4 * base delay
...
не больше DISCORD_RETRY_MAX_DELAY_MS
```

После задержки событие заново встаёт в конец расписания канала. По умолчанию `DISCORD_RETRY_MAX_ATTEMPTS=0`: повторы продолжаются до успешной доставки. Если задать положительное значение, после этого числа попыток событие уйдёт в DLX.

### `400` и DLX

`400` означает неправильно составленный webhook: повтор всегда даст ту же ошибку. Такое событие логируется (`discord.webhook.dead_lettered`) и сразу отправляется в DLX с полным envelope:

- `eventId`;
- `channelId`;
- `webhookUrl`;
- payload;
- reason;
- statusCode;
- attempts;
- timestamps.

## Transactional outbox

Таблица `webhook_outbox_events` хранит исходный event, destination, payload, metadata, status, attempts, lease и last error. Схема создаётся приложением при старте (`CREATE TABLE IF NOT EXISTS`).

Статусы:

```text
pending -> publishing -> published
```

Publisher использует:

- немедленный запуск после каждого INSERT (вызовы во время публикации схлопываются в один повторный проход);
- polling раз в `OUTBOX_POLL_INTERVAL_MS` как страховку;
- `FOR UPDATE SKIP LOCKED` и lease timeout;
- exponential backoff (до минуты), если Redis недоступен;
- детерминированный BullMQ job id из `eventId`;
- `ON CONFLICT DO NOTHING` для повторного enqueue того же `eventId`.

Если publisher упал до `queue.add`, lease истечёт и событие будет взято снова. Если он упал после `queue.add`, но до `markPublished`, повторный `queue.add` с тем же job id BullMQ проигнорирует: завершённые jobs хранятся час — это с большим запасом дольше lease (`30s` по умолчанию), и при этом Redis не копит payload завершённых задач.

Каждый перенос job (ожидание слота, `429`, retry) создаёт новую delayed job с детерминированным id `<eventId>--r<N>`, поэтому повторный запуск job после падения worker тоже не создаёт копию.

`EnqueueWebhookService` пишет в outbox через собственный pool. Чтобы запись события была атомарной с изменением бизнес-данных, INSERT в outbox нужно выполнять в той же транзакции, что и бизнес-изменения (см. [Production considerations](#production-considerations)).

## Demo API

Входные данные валидируются (`class-validator`): `webhookUrl` принимается только в формате `https://discord.com/api/webhooks/...`, некорректный запрос получает `400` от API.

### Одно событие

```bash
curl -X POST http://localhost:3000/demo/webhook \
  -H 'content-type: application/json' \
  -d '{
    "eventId": "user-123-registered",
    "channelId": "new-users",
    "webhookUrl": "https://discord.com/api/webhooks/...",
    "payload": { "embeds": [{ "title": "New user", "description": "User registered" }] }
  }'
```

### Burst одного канала

```bash
curl -X POST http://localhost:3000/demo/burst \
  -H 'content-type: application/json' \
  -d '{ "count": 10, "channelId": "channel-a" }'
```

### Burst двух независимых channels

```bash
curl -X POST http://localhost:3000/demo/burst-both \
  -H 'content-type: application/json' \
  -d '{ "count": 10 }'
```

### Queue status

```bash
curl http://localhost:3000/demo/queue-status
curl "http://localhost:3000/demo/queue-status?runId=load-..."
```

Run-scoped статус считает события по последней job каждого события: `pending` — ещё не доставленные (waiting, active, delayed), `completed` — доставленные, `failed` — ушедшие в DLX или failed.

На Windows вместо `curl` удобно использовать `Invoke-RestMethod`:

```powershell
Invoke-RestMethod -Uri 'http://localhost:3000/demo/burst' -Method Post `
  -ContentType 'application/json' -Body '{ "count": 10, "channelId": "channel-a" }'
```

## Нагрузочное тестирование

Нагрузочный скрипт запускается в отдельном терминале при работающем Docker Compose. Скрипт сам завершается, когда доставка закончена: `pending = 0` и `produced = completed + failed`.

```bash
# 30 событий одного канала
npm run test:load -- --count=30 --channel=load-test-channel

# 500 событий одного канала (при 2/sec это около 4-5 минут)
npm run test:load -- --count=500 --channel=load-test-channel

# По 500 событий в Channel A и Channel B параллельно
npm run test:load -- --count=500 --both=true

# Без итогового summary webhook
npm run test:load -- --count=30 --channel=load-test-channel --send-summary=false

# Другой интервал опроса статуса
npm run test:load -- --count=100 --poll-ms=500
```

### Что выводит load-test

В процессе: `produced`, `completed`, `failed`, `pending`, `dlxWaiting`, `accountedMatchesProduced` (ожидается `produced === completed + pending + failed`).

В конце:

```text
=== LOAD TEST SUMMARY ===
produced
completed
failed
dlxWaiting
pending
enqueueDurationMs
totalDurationMs
throughputPerSecond
averageDeliveryMs
```

Для успешного запуска из 25 событий ожидается:

```text
produced: 25
completed: 25
failed: 0
pending: 0
dlxWaiting: 0
```

### Как проверить retry после `429`

```bash
docker compose logs --since=15m app | grep -c "Discord Retry-After"
docker compose logs --since=15m app | grep -c "discordMessageId"
docker compose logs --since=15m app | grep -c "discord.webhook.dead_lettered"
```

Наличие `Discord Retry-After` подтверждает, что Discord реально прислал rate-limit signal, а не только внутренний limiter отложил job.

## Сценарии отказов

| Сценарий                    | Что происходит                                                               | Ожидаемый результат                                      |
| --------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------- |
| `2xx`                       | job завершается                                                              | `completed + 1`                                          |
| `429`                       | пауза всего канала на `Retry-After`, расписание сдвигается                   | eventual success; другие каналы не ждут                  |
| `400`                       | некорректный webhook                                                         | лог + DLX без retry                                      |
| `401/403/404`               | retry с backoff                                                              | success после исправления или вечный retry (нужен алерт) |
| `5xx`, timeout, network     | retry с backoff + jitter                                                     | eventual success                                         |
| worker отстал от расписания | send permit выдерживает интервал, давно опоздавшие jobs получают новые слоты | не больше 2/sec, без всплеска и без лишних пробуждений   |
| `X-RateLimit-Remaining: 0`  | канал заранее ставится на паузу до сброса лимита                             | 429 не возникает                                         |
| Redis restart               | скрипты перезагружаются автоматически (`NOSCRIPT` → `EVAL`)                  | доставка продолжается                                    |
| Redis недоступен            | BullMQ job retry, outbox backoff                                             | recovery после возврата Redis                            |
| PostgreSQL недоступен       | enqueue не подтверждается                                                    | бизнес-событие не теряется молча                         |
| worker crash                | stalled job возвращается в очередь                                           | продолжение после restart                                |
| duplicate `eventId`         | outbox `ON CONFLICT DO NOTHING`, детерминированный job id                    | дубль job не создаётся                                   |

### Проверка DLX

Намеренно некорректный webhook: Discord отвечает `400`, событие уходит в DLX без повторов.

```bash
npm run test:load -- --count=10 --channel=dlx-test \
  --webhook-url=https://discord.com/api/webhooks/invalid/invalid \
  --send-summary=false

curl http://localhost:3000/demo/queue-status
```

Ожидается увеличение `dlxWaiting` на 10.

## Перезапуск и восстановление

```bash
# Перезапуск app без очистки данных
docker compose restart app

# Полный down/up с сохранением volumes
docker compose down
docker compose up -d

# Полный сброс локальной среды (удаляет Redis и PostgreSQL volumes)
docker compose down -v
docker compose up -d --build
```

Redis AOF и PostgreSQL named volume сохраняют незавершённые jobs и outbox rows.

## Подключение к PostgreSQL

В pgAdmin, DBeaver или другом клиенте:

```text
Host: localhost
Port: 5444
Database: discord_limits
User: discord_app
Password: discord_app_password
SSL: Disable
```

Основная outbox-таблица:

```sql
SELECT event_id, status, attempts, created_at, published_at, last_error
FROM webhook_outbox_events
ORDER BY created_at DESC;
```

## Конфигурация

| Variable                              | Назначение                                                               | Default                        |
| ------------------------------------- | ------------------------------------------------------------------------ | ------------------------------ |
| `PORT`                                | HTTP port                                                                | `3000`                         |
| `REDIS_HOST`                          | Redis host                                                               | `localhost`                    |
| `REDIS_PORT`                          | Redis port (внутри Docker)                                               | `6379`                         |
| `REDIS_HOST_PORT`                     | Порт Redis на хосте (Compose, интеграционные тесты)                      | `6380`                         |
| `POSTGRES_HOST`                       | PostgreSQL host                                                          | `localhost`                    |
| `POSTGRES_PORT`                       | PostgreSQL port                                                          | `5432` внутри Docker           |
| `POSTGRES_DB`                         | Database                                                                 | `discord_limits`               |
| `POSTGRES_USER`                       | User                                                                     | `discord_app`                  |
| `POSTGRES_PASSWORD`                   | Password                                                                 | `discord_app_password`         |
| `POSTGRES_POOL_SIZE`                  | PG pool size                                                             | `10`                           |
| `OUTBOX_POLL_INTERVAL_MS`             | Polling-страховка publisher                                              | `1000`                         |
| `OUTBOX_BATCH_SIZE`                   | Outbox batch size                                                        | `100`                          |
| `OUTBOX_LEASE_MS`                     | Lease timeout                                                            | `30000`                        |
| `DISCORD_RATE_LIMIT_PER_SECOND`       | Лимит отправок на канал                                                  | `2`                            |
| `DISCORD_RATE_LIMIT_CLEANUP_GRACE_MS` | TTL grace ключа канала после последнего слота                            | `1000`                         |
| `DISCORD_WORKER_CONCURRENCY`          | Worker concurrency                                                       | `10`                           |
| `DISCORD_REQUEST_TIMEOUT_MS`          | HTTP timeout                                                             | `10000`                        |
| `DISCORD_WAIT_FOR_MESSAGE`            | Запрашивать у Discord тело сообщения (`message.id`)                      | `true`                         |
| `DISCORD_RETRY_MAX_ATTEMPTS`          | Лимит попыток для не-`400` ошибок (`0` — без лимита; `429` не считается) | `0`                            |
| `DISCORD_RETRY_BASE_DELAY_MS`         | Базовая задержка retry                                                   | `1000`                         |
| `DISCORD_RETRY_MAX_DELAY_MS`          | Максимальная задержка retry                                              | `300000`                       |
| `DISCORD_WEBHOOK_A`                   | Demo webhook A                                                           | required for demo              |
| `DISCORD_WEBHOOK_B`                   | Demo webhook B                                                           | required for both-channel demo |

`.env` не коммитится. Webhook URL нельзя публиковать или выводить в логи.

## Тесты проекта

| Команда                          | Что проверяет                                                         | Нужен стек               |
| -------------------------------- | --------------------------------------------------------------------- | ------------------------ |
| `npm test`                       | Unit: processor (400/429/retry/backoff), classifier, limiter, enqueue | нет                      |
| `npm run test:e2e`               | HTTP demo API: валидация входа                                        | нет                      |
| `npm run test:redis-integration` | Lua limiter на реальном Redis                                         | Redis                    |
| `npm run test:load`              | Outbox → BullMQ → rate limit → Discord / DLX                          | Docker Compose + webhook |

`npm test` пропускает Redis integration suite: она включается только через `npm run test:redis-integration`.

Интеграционная проверка limiter на реальном Redis (по умолчанию `localhost:6380`, можно переопределить через `REDIS_TEST_HOST` / `REDIS_TEST_PORT`):

```bash
docker compose up -d redis
npm run test:redis-integration
```

Она проверяет:

- позднее событие после уже зарезервированной пачки встаёт в конец расписания;
- независимость разных каналов;
- автоматическое истечение ключа канала после последнего слота + grace;
- опоздавшие jobs не уходят чаще интервала;
- backlog давно опоздавших jobs раскладывается по новым слотам, а вовремя пришедшая job сохраняет свой слот;
- после `429` канал на паузе целиком, расписание сдвинуто без дыр, другой канал работает;
- limiter продолжает работать после потери кэша Lua-скриптов (рестарт Redis).

Остальные проверки:

```bash
npm ci
npm run lint
npm run format:check
npx tsc --noEmit
npm run build
docker compose config
```

## Безопасность

- `.env` и webhook URL не коммитятся и не пишутся в логи;
- Demo API принимает только Discord webhook URLs, поэтому сервис нельзя использовать для запросов на произвольные хосты;
- webhook URL — это секрет: он хранится в outbox-событии и в DLX envelope, поэтому доступ к PostgreSQL и Redis нужно ограничивать так же, как к секретам;
- credentials из `docker-compose.yml` и README предназначены только для локальной разработки;
- в production webhook URL лучше хранить в secret manager и передавать в событии только идентификатор destination.

## Trade-offs

### Redis + BullMQ вместо Kafka

Меньше инфраструктуры и естественная поддержка delayed jobs. Kafka была бы оправдана event-streaming требованиями, которых у этого модуля нет.

### Custom limiter вместо BullMQ Pro

Не нужен платный group limiter. Redis Lua даёт per-channel distributed reservation и остаётся прозрачным для review.

### Одна queue вместо queue-per-channel

Одна queue проще операционно. Изоляция достигается в данных job и Redis keys, а не размножением инфраструктуры.

### At-least-once вместо exactly-once

Это честная семантика для внешнего HTTP API. Event ID и детерминированные job id убирают дубли внутри системы, но не могут отменить неопределённость network timeout.

### Configured safety ceiling

Даже если Discord возвращает более высокий bucket limit, локальный лимит остаётся ограничителем. Это сознательный приоритет отсутствия `429` над максимальным throughput.

### Повторы без лимита

Только `400` однозначно означает «событие никогда не будет доставлено». Остальные ошибки могут быть временными (`5xx`, сеть) или исправимыми (`401/403/404` — webhook пересоздан или восстановлен), поэтому событие не выбрасывается. Обратная сторона: если webhook удалён навсегда, события этого канала будут повторяться с максимальной задержкой (`DISCORD_RETRY_MAX_DELAY_MS`). В production такой сценарий закрывается алертом; при необходимости можно включить `DISCORD_RETRY_MAX_ATTEMPTS`.

## Production considerations

В production дополнительно стоит рассмотреть:

- INSERT в outbox в той же транзакции, что и бизнес-изменения (передавать транзакционный client в `OutboxRepository`);
- настоящий migration tool вместо `CREATE TABLE IF NOT EXISTS` при старте;
- secret manager и encryption webhook URLs;
- OpenTelemetry и distributed tracing;
- Prometheus metrics и alerting: длительная пауза канала, долгие retry `401/403/404`, рост DLX;
- redrive из DLX после исправления payload;
- cleanup policy для published outbox rows;
- managed Redis/PostgreSQL и backups.
