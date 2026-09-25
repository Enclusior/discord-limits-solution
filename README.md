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

- Discord ограничивает частоту запросов;
- `429 Too Many Requests` нельзя считать окончательной ошибкой;
- сетевой timeout оставляет неоднозначный результат: Discord мог принять сообщение;
- один медленный канал не должен блокировать другой;
- процесс может упасть между созданием события и фактической доставкой;
- конфигурационные ошибки webhook не должны создавать бесконечный retry loop.

Модуль разделяет эти ответственности:

```text
Business application
        |
        | durable enqueue
        v
PostgreSQL transactional outbox
        |
        | publisher with lease
        v
BullMQ: discord-webhooks  <---->  Redis
        |
        | per-channel atomic reservation
        v
Discord Webhook transport
        |
        +--> success
        +--> Retry-After / delayed retry
        +--> retryable failure
        +--> DLX
```

Главная идея: очередь сама по себе не решает rate limit, а rate limiter сам по себе не решает durable delivery. BullMQ отвечает за jobs и scheduling, Redis за распределённую координацию, PostgreSQL за durable handoff, transport за Discord HTTP semantics.

## Что гарантирует система

### Гарантируется

- одна durable очередь для webhook jobs;
- отдельная DLX queue для необрабатываемых событий;
- safety limit по умолчанию `2 webhook/sec` на каждый `channelId`;
- независимая обработка Channel A и Channel B;
- атомарная reservation слота через Redis Lua;
- delayed reschedule вместо удержания worker через долгий `sleep`;
- Discord `429` с использованием `Retry-After`;
- ограниченный retry для `5xx`, timeout и network failures;
- `400`, `401`, `403`, `404` как permanent failure в DLX;
- сохранение событий в PostgreSQL до публикации в BullMQ;
- восстановление outbox после падения publisher/application;
- at-least-once delivery semantics;
- логирование Discord `message.id`, если включён `DISCORD_WAIT_FOR_MESSAGE=true`.

### Не гарантируется

Exactly-once доставка в Discord невозможна через обычный HTTP Webhook без idempotency API на стороне Discord. Если Discord принял сообщение, но TCP-соединение оборвалось до ответа, retry может создать duplicate message.

## Быстрый запуск

### Требования

- Windows, macOS или Linux;
- Node.js 22+;
- npm;
- Docker Desktop с запущенным Docker Engine;
- тестовый Discord-сервер и webhook URL.

### 1. Создать `.env`

Из корня проекта:

```powershell
Copy-Item .env.example .env
notepad .env
```

Для macOS/Linux:

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

```powershell
docker compose up -d --build
```

Если менялся только `.env`:

```powershell
docker compose up -d --force-recreate
```

Если код и зависимости не менялись:

```powershell
docker compose up -d
```

Compose запускает:

- `app` на `http://localhost:3000`;
- Redis для BullMQ/rate limiter;
- PostgreSQL на `localhost:5444` для подключения с Windows.

Внутри Docker приложение подключается к PostgreSQL как `postgres:5432`.

### 3. Проверить контейнеры

```powershell
docker compose ps
```

Для macOS/Linux используется та же команда:

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

```powershell
Invoke-RestMethod "http://localhost:3000/health"
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

```powershell
docker compose logs -f app
```

На macOS/Linux команда идентична:

```bash
docker compose logs -f app
```

Общий статус очередей:

```powershell
Invoke-RestMethod "http://localhost:3000/demo/queue-status"
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
           |
           v
+------------------------------+
| PostgreSQL Outbox             |
| pending -> publishing ->     |
| published                     |
+--------------+---------------+
               |
               v
+------------------------------+
| OutboxPublisher               |
| lease + SKIP LOCKED           |
+--------------+---------------+
               |
               v
+------------------------------+
| BullMQ discord-webhooks       |
+--------------+---------------+
               |
               v
+------------------------------+
| WebhookProcessor              |
| concurrency configurable      |
+------+-----------------------+
       |
       +--> Redis Lua limiter per channel
       |
       +--> DiscordWebhookTransport
       |
       +--> ResponseClassifier
       |
       +--> DLX discord-webhooks-dlx
```

### Основные границы ответственности

| Компонент               | Ответственность                                        |
| ----------------------- | ------------------------------------------------------ |
| `EnqueueWebhookService` | Сохранить событие в PostgreSQL outbox                  |
| `OutboxRepository`      | Insert, lease, retry и published state                 |
| `OutboxPublisher`       | Перенести outbox event в BullMQ                        |
| BullMQ                  | Durable jobs, delayed scheduling и worker coordination |
| Redis Lua limiter       | Atomic per-channel reservation                         |
| `WebhookProcessor`      | State machine доставки                                 |
| Discord transport       | HTTP request, headers и response body                  |
| Response classifier     | `2xx`, `429`, permanent и retryable errors             |
| DLX                     | Полный envelope окончательно не доставленного события  |

## Почему выбран этот стек

### Почему BullMQ

BullMQ уже решает нужные задачи:

- durable jobs в Redis;
- delayed jobs;
- worker concurrency;
- recovery после worker crash;
- coordination нескольких worker-инстансов;
- понятные queue metrics.

Kafka здесь избыточен: проекту не нужна event-streaming платформа и replay log на огромных объёмах. RabbitMQ возможен, но добавил бы ещё один инфраструктурный компонент, а per-channel rate limiter всё равно пришлось бы реализовывать отдельно.

### Почему Redis

Redis используется сразу для двух связанных задач:

1. BullMQ backend.
2. Распределённое состояние rate limiter.

Lua script делает check-and-reserve атомарным. Поэтому Worker A и Worker B не смогут одновременно забрать один и тот же слот одного канала.

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

С outbox:

```text
DB transaction + outbox INSERT
              |
             COMMIT
              |
              v
       asynchronous publisher
              |
              v
            BullMQ
```

Если publisher упал, запись остаётся в PostgreSQL и будет обработана после lease expiration.

### Почему не `sleep`

`await sleep(5000)` внутри worker удерживает concurrency slot. При большом потоке это блокирует обработку других каналов.

Вместо этого job переводится в delayed state. Worker освобождается, а Redis reservation сохраняется в `reservedAt`.

## Rate limiting и retry

### Per-channel limit

По умолчанию:

```env
DISCORD_RATE_LIMIT_PER_SECOND=2
```

Это даёт примерно равномерное расписание:

```text
0ms
500ms
1000ms
1500ms
```

`DISCORD_WORKER_CONCURRENCY=10` не заменяет rate limit. Concurrency и rate limit решают разные задачи:

- concurrency: сколько jobs может обрабатываться одновременно;
- rate limit: сколько отправок разрешено за интервал времени.

### Discord `429`

При `429` processor:

1. читает body `retry_after`;
2. учитывает header `Retry-After`;
3. планирует delayed retry;
4. не блокирует другие channels;
5. сохраняет delivery attempt count.

Exponential backoff не применяется вместо `Retry-After`.

### Retryable errors

Для network errors и `5xx` используется ограниченный backoff:

```text
base delay
2 * base delay
4 * base delay
8 * base delay
```

Добавляется jitter, чтобы несколько worker-ов не повторяли запросы одновременно.

### Permanent errors

Ошибки `400`, `401`, `403`, `404` не ретраятся бесконечно. Полный envelope отправляется в DLX:

- `eventId`;
- `channelId`;
- `webhookUrl`;
- payload;
- reason;
- statusCode;
- attempts;
- timestamps.

## Transactional outbox

Таблица `webhook_outbox_events` хранит:

- исходный event;
- destination;
- payload;
- metadata;
- status;
- attempts;
- lease;
- last error.

Статусы:

```text
pending -> publishing -> published
```

Publisher использует:

- `FOR UPDATE SKIP LOCKED`;
- lease timeout;
- deterministic BullMQ job id;
- `ON CONFLICT DO NOTHING` для duplicate enqueue.

Если publisher упал после `queue.add`, повторный duplicate job считается уже опубликованным. Если publisher упал до `queue.add`, lease истечёт и событие будет взято снова.

## Demo API

Все HTTP-команды ниже можно выполнить через `curl` на macOS/Linux. На Windows удобнее использовать `Invoke-RestMethod`, приведённый в PowerShell-примерах.

### Одно событие

```powershell
$body = @{
  eventId = 'user:123:registered'
  channelId = 'new-users'
  webhookUrl = $env:DISCORD_WEBHOOK_A
  payload = @{
    embeds = @(
      @{
        title = 'New user'
        description = 'User registered'
      }
    )
  }
} | ConvertTo-Json -Depth 8

Invoke-RestMethod `
  -Uri 'http://localhost:3000/demo/webhook' `
  -Method Post `
  -ContentType 'application/json' `
  -Body $body
```

### Burst одного канала

```powershell
$body = @{ count = 10; channelId = 'channel-a' } | ConvertTo-Json
Invoke-RestMethod `
  -Uri 'http://localhost:3000/demo/burst' `
  -Method Post `
  -ContentType 'application/json' `
  -Body $body
```

### Burst двух независимых channels

```powershell
$body = @{ count = 10 } | ConvertTo-Json
Invoke-RestMethod `
  -Uri 'http://localhost:3000/demo/burst-both' `
  -Method Post `
  -ContentType 'application/json' `
  -Body $body
```

### Queue status

```powershell
Invoke-RestMethod 'http://localhost:3000/demo/queue-status'
```

### Run-scoped metrics

Нагрузочный скрипт генерирует `runId` и получает статистику только своего запуска:

```powershell
Invoke-RestMethod 'http://localhost:3000/demo/queue-status?runId=load-...'
```

## Нагрузочное тестирование

Нагрузочный скрипт запускается в отдельном PowerShell, пока Docker Compose работает в первом.

### 30 событий одного канала

```powershell
npm run test:load -- --count=30 --channel=load-test-channel
```

macOS/Linux:

```bash
npm run test:load -- --count=30 --channel=load-test-channel
```

### 500 событий одного канала

```powershell
npm run test:load -- --count=500 --channel=load-test-channel
```

При лимите `2/sec` 500 событий займут около 4-5 минут. Это ожидаемо: тест проверяет соблюдение внешнего ограничения и отсутствие потерь.

### Два канала параллельно

```powershell
npm run test:load -- --count=500 --both=true
```

macOS/Linux:

```bash
npm run test:load -- --count=500 --both=true
```

Будет создано по 500 jobs на Channel A и Channel B. При двух webhook URL оба канала должны обрабатываться параллельно.

### Отключить summary webhook

```powershell
npm run test:load -- --count=30 --channel=load-test-channel --send-summary=false
```

### Указать interval polling

```powershell
npm run test:load -- --count=100 --poll-ms=500
```

### Что выводит load-test

В процессе:

```text
waiting
active
delayed
completed
failed
dlxWaiting
pending
```

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

Если `DISCORD_WAIT_FOR_MESSAGE=true`, успешный Discord response содержит реальный `discordMessageId`. Его можно проверить в логах:

```powershell
docker compose logs --since=15m app |
  Select-String 'discordMessageId:'
```

### Как доказать успешный retry после `429`

```powershell
$logs = docker compose logs --since=15m app

'Retry-After:'
($logs | Select-String 'Discord Retry-After').Count

'Successful Discord responses:'
($logs | Select-String 'discordMessageId:').Count

'DLX:'
($logs | Select-String 'discord.webhook.dead_lettered').Count
```

Для успешного запуска из 25 событий ожидается:

```text
produced: 25
completed: 25
failed: 0
pending: 0
dlxWaiting: 0
```

Наличие `Discord Retry-After` подтверждает, что Discord реально прислал rate-limit signal, а не только внутренний limiter отложил job.

## Сценарии отказов

| Сценарий               | Что происходит                      | Ожидаемый результат                     |
| ---------------------- | ----------------------------------- | --------------------------------------- |
| `2xx`                  | job завершается                     | `completed + 1`                         |
| `429`                  | чтение `Retry-After`, delayed retry | eventual success или DLX после лимита   |
| `400`                  | permanent failure                   | DLX без retry loop                      |
| `401/403/404`          | invalid/configuration destination   | DLX                                     |
| `5xx`                  | exponential retry + jitter          | success или DLX                         |
| timeout                | retryable error                     | retry с backoff                         |
| Redis unavailable      | jobs остаются в Redis volume        | recovery после Redis return             |
| PostgreSQL unavailable | enqueue не подтверждается           | бизнес-событие не теряется молча        |
| worker crash           | незавершённые jobs recover          | продолжение после restart               |
| Channel A rate limited | A delayed                           | Channel B продолжает отправку           |
| duplicate eventId      | outbox `ON CONFLICT DO NOTHING`     | uncontrolled duplicate job не создаётся |

### Проверка DLX

Намеренно неверный webhook URL:

```powershell
npm run test:load -- `
  --count=10 `
  --channel=dlx-test `
  --webhook-url=https://discord.com/api/webhooks/invalid/invalid `
  --send-summary=false
```

Проверка:

```powershell
Invoke-RestMethod 'http://localhost:3000/demo/queue-status'
```

Для invalid destination ожидается увеличение `dlxWaiting`.

## Перезапуск и восстановление

### Перезапуск app без очистки данных

```powershell
docker compose restart app
```

macOS/Linux:

```bash
docker compose restart app
```

### Полный down/up с сохранением volumes

```powershell
docker compose down
docker compose up -d
```

macOS/Linux:

```bash
docker compose down
docker compose up -d
```

Redis AOF и PostgreSQL named volume сохраняют незавершённые jobs/outbox rows.

### Полный сброс локальной среды

```powershell
docker compose down -v
docker compose up -d --build
```

macOS/Linux:

```bash
docker compose down -v
docker compose up -d --build
```

`down -v` удаляет Redis и PostgreSQL volumes, поэтому использовать его следует только для чистого теста.

## Подключение к PostgreSQL с Windows

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

### Подключение с macOS/Linux

Параметры подключения те же, потому что Docker публикует PostgreSQL на host-порт `5444`:

```text
Host: localhost
Port: 5444
Database: discord_limits
User: discord_app
Password: discord_app_password
SSL: Disable
```

Проверить доступность через `psql`:

```bash
PGPASSWORD=discord_app_password psql \
  -h localhost \
  -p 5444 \
  -U discord_app \
  -d discord_limits \
  -c "SELECT event_id, status, attempts FROM webhook_outbox_events ORDER BY created_at DESC;"
```

## Конфигурация

| Variable                        | Назначение                      | Default                        |
| ------------------------------- | ------------------------------- | ------------------------------ |
| `PORT`                          | HTTP port                       | `3000`                         |
| `REDIS_HOST`                    | Redis host                      | `localhost`                    |
| `REDIS_PORT`                    | Redis port                      | `6379`                         |
| `POSTGRES_HOST`                 | PostgreSQL host                 | `localhost`                    |
| `POSTGRES_PORT`                 | PostgreSQL port                 | `5432` внутри Docker           |
| `POSTGRES_DB`                   | Database                        | `discord_limits`               |
| `POSTGRES_USER`                 | User                            | `discord_app`                  |
| `POSTGRES_PASSWORD`             | Password                        | `discord_app_password`         |
| `POSTGRES_POOL_SIZE`            | PG pool size                    | `10`                           |
| `OUTBOX_POLL_INTERVAL_MS`       | Publisher polling interval      | `1000`                         |
| `OUTBOX_BATCH_SIZE`             | Outbox batch size               | `100`                          |
| `OUTBOX_LEASE_MS`               | Lease timeout                   | `30000`                        |
| `DISCORD_RATE_LIMIT_PER_SECOND` | Safety limit per channel        | `2`                            |
| `DISCORD_WORKER_CONCURRENCY`    | Worker concurrency              | `10`                           |
| `DISCORD_REQUEST_TIMEOUT_MS`    | HTTP timeout                    | `10000`                        |
| `DISCORD_WAIT_FOR_MESSAGE`      | Ask Discord for message body/id | `true`                         |
| `DISCORD_RETRY_MAX_ATTEMPTS`    | Retry limit                     | `5`                            |
| `DISCORD_RETRY_BASE_DELAY_MS`   | Retry base delay                | `1000`                         |
| `DISCORD_RETRY_MAX_DELAY_MS`    | Retry max delay                 | `30000`                        |
| `DISCORD_WEBHOOK_A`             | Demo webhook A                  | required for demo              |
| `DISCORD_WEBHOOK_B`             | Demo webhook B                  | required for both-channel demo |

`.env` не коммитится. Webhook URL нельзя публиковать или выводить в логи.

## Тесты проекта

Установить зависимости:

```powershell
npm ci
```

Lint:

```powershell
npm run lint
npm run lint:fix
```

Format:

```powershell
npm run format
npm run format:check
```

Build:

```powershell
npm run build
```

Unit tests:

```powershell
npm test
npm test -- --runInBand
npm run test:cov
```

E2E:

```powershell
npm run test:e2e
```

Compose validation:

```powershell
docker compose config
```

## Trade-offs

### Redis + BullMQ вместо Kafka

Меньше инфраструктуры и естественная поддержка delayed jobs. Kafka была бы оправдана event streaming требованиями, которых у этого модуля нет.

### Custom limiter вместо BullMQ Pro

Не нужен платный group limiter. Redis Lua даёт per-channel distributed reservation и остаётся прозрачным для review.

### Одна queue вместо queue-per-channel

Одна queue проще операционно. Изоляция достигается в данных job и Redis keys, а не размножением инфраструктуры.

### At-least-once вместо exactly-once

Это честная семантика для внешнего HTTP API. Event ID помогает deduplicate enqueue, но не может отменить неопределённость network timeout.

### Configured safety ceiling

Даже если Discord возвращает более высокий bucket limit, локальный safety limit из задания остаётся ограничителем. Это сознательный приоритет correctness над максимальным throughput.

## Production considerations

В production дополнительно стоит рассмотреть:

- настоящий migration tool вместо init SQL;
- secret manager и encryption webhook URLs;
- transactional outbox в той же бизнес-транзакции, что и domain changes;
- OpenTelemetry и distributed tracing;
- Prometheus metrics и alerting;
- отдельную политику хранения completed jobs;
- webhook health management и automatic disable после permanent errors;
- managed Redis/PostgreSQL и backups;
- несколько publisher replicas с lease coordination;
- cleanup policy для published outbox rows;
- idempotency support на стороне downstream API.

## Git history

История проекта разбита на небольшие Conventional Commits:

```text
chore: initialize NestJS project
feat: add BullMQ webhook delivery pipeline
feat: add demo API and Docker environment
test: cover webhook delivery scenarios
refactor: polish project structure and module aliases
test: add webhook load testing scenario
fix: preserve rate limit reservations across retries
fix: normalize BullMQ job identifiers
feat: persist Redis queue data across restarts
feat: add PostgreSQL transactional outbox
```
