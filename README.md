# Discord Webhook Delivery Module

Переиспользуемый NestJS-модуль для надёжной асинхронной доставки Discord Webhook-сообщений. Проект рассчитан на сценарий, в котором события нельзя терять при всплесках нагрузки, каналы должны обрабатываться независимо, а внешний rate limit Discord необходимо соблюдать при нескольких worker-инстансах.

## Возможности

- одна durable BullMQ queue `discord-webhooks`;
- отдельная DLX queue `discord-webhooks-dlx`;
- Redis как backend очереди и источник распределённого rate-limit state;
- атомарная Lua reservation для каждого channel/bucket key;
- safety limit по умолчанию `2 webhook/sec` на канал;
- delayed rescheduling вместо долгого `sleep` внутри worker;
- `429` с приоритетом Discord `retry_after`/`Retry-After`;
- ограниченный exponential backoff с jitter для `5xx` и network failures;
- permanent failures (`400`, `401`, `403`, `404`) в DLX без бесконечного retry;
- eventId как BullMQ job id для deduplication;
- structured event logging без полного webhook URL;
- demo endpoints, health endpoint и queue status;
- Docker Compose с Redis и приложением.

## Архитектура

```text
Application / Demo API
          |
          v
DiscordWebhookModule
          |
          v
BullMQ: discord-webhooks  --->  Redis
          |                        |
          |                        +-- atomic Lua reservation
          v
WebhookProcessor
    |             |
    v             v
Channel A      Channel B
Limiter        Limiter
    |             |
    v             v
Discord A      Discord B

Permanent failures ---> discord-webhooks-dlx
```

Очередь отвечает за durable jobs, delayed scheduling и восстановление после worker restart. Redis координирует per-channel reservations между несколькими процессами. Transport отвечает только за HTTP и интерпретацию ответа Discord.

### Почему не global BullMQ limiter

Обычный BullMQ limiter ограничивал бы всю queue. Нам нужно `A -> 2/sec` и одновременно `B -> 2/sec`, поэтому rate limit вынесен в Redis-based механизм с ключом канала. Queue остаётся одной: channel isolation является свойством job scheduling, а не количеством очередей.

### Почему Lua

Проверка `nextAllowedAt` и reservation следующего слота выполняются одной Redis-операцией. Несколько worker'ов не смогут одновременно получить один и тот же слот.

### Почему не sleep

Если канал заблокирован на несколько секунд, job переводится в delayed state и освобождает worker. Это сохраняет concurrency для других каналов.

## Delivery semantics

Сервис предоставляет **at-least-once delivery**.

Очередь сохраняет pending jobs, а незавершённые jobs могут быть обработаны после restart. Однако HTTP request имеет неоднозначный случай: Discord мог принять сообщение, а соединение могло оборваться до получения ответа. Поэтому повторная попытка теоретически создаёт duplicate message. Exactly-once через обычный Discord Webhook гарантировать нельзя.

`eventId` используется как job id BullMQ и помогает предотвращать неконтролируемый duplicate enqueue. Это не превращает внешний HTTP API в exactly-once transport.

Reservation может быть потеряна, если worker упал после Redis reservation, но до HTTP request. Это сознательный trade-off: потеря небольшого временного слота безопаснее, чем нарушение общего rate limit.

## HTTP failure policy

| Сценарий               | Поведение                                                         |
| ---------------------- | ----------------------------------------------------------------- |
| `2xx`                  | Job завершена успешно                                             |
| `400`                  | Permanent failure, логирование и DLX                              |
| `401/403/404`          | Permanent/configuration failure и DLX                             |
| `429`                  | Delayed reschedule по body `retry_after` или header `Retry-After` |
| `5xx`                  | Ограниченный retry с exponential backoff и jitter                 |
| timeout/network error  | Ограниченный retry с exponential backoff и jitter                 |
| retry limit исчерпан   | DLX с исходным envelope и причиной                                |
| Channel A rate limited | Channel B продолжает работу                                       |

При наличии Discord bucket header transport/classifier сохраняет его в delivery result; текущий safety key по умолчанию строится по channel. Business-level isolation и реальные Discord buckets не являются полностью одинаковыми понятиями: Discord может группировать endpoints по своим bucket rules.

## Публичный API

```typescript
await discordWebhookService.enqueue({
  eventId: 'user:123:registered',
  channelId: 'new-users',
  webhookUrl: process.env.DISCORD_WEBHOOK_A!,
  payload: {
    embeds: [
      {
        title: 'New user',
        description: 'User registered',
      },
    ],
  },
});
```

Вызывающий код не занимается retry, rate limit, Discord HTTP errors или DLX.

## Local setup

Требования: Node.js 22+, npm и Docker Desktop с запущенным Docker Engine.

```powershell
Copy-Item .env.example .env
```

Заполните `DISCORD_WEBHOOK_A` и при необходимости `DISCORD_WEBHOOK_B`, затем:

```powershell
docker compose up --build
```

Остановка:

```powershell
docker compose down
```

Redis устанавливать отдельно не нужно.

## Demo API

Проверка health:

```powershell
curl.exe http://localhost:3000/health
```

Одно событие:

```powershell
curl.exe -X POST http://localhost:3000/demo/webhook `
  -H "Content-Type: application/json" `
  -d '{"eventId":"user:123:registered","channelId":"new-users","webhookUrl":"https://discord.com/api/webhooks/placeholder/placeholder","payload":{"embeds":[{"title":"New user","description":"User registered"}]}}'
```

Burst одного канала:

```powershell
curl.exe -X POST http://localhost:3000/demo/burst `
  -H "Content-Type: application/json" `
  -d '{"channelId":"channel-a","count":20}'
```

Burst двух независимых каналов:

```powershell
curl.exe -X POST http://localhost:3000/demo/burst-both `
  -H "Content-Type: application/json" `
  -d '{"count":20}'
```

Статус очередей:

```powershell
curl.exe http://localhost:3000/demo/queue-status
```

## Environment

| Variable                        | Description                     | Default                 |
| ------------------------------- | ------------------------------- | ----------------------- |
| `PORT`                          | HTTP port                       | `3000`                  |
| `REDIS_HOST`                    | Redis host                      | `localhost`             |
| `REDIS_PORT`                    | Redis port                      | `6379`                  |
| `DISCORD_RATE_LIMIT_PER_SECOND` | Safety limit per channel        | `2`                     |
| `DISCORD_WORKER_CONCURRENCY`    | Overall worker concurrency      | `10`                    |
| `DISCORD_REQUEST_TIMEOUT_MS`    | Discord HTTP timeout            | `10000`                 |
| `DISCORD_RETRY_MAX_ATTEMPTS`    | Max retryable delivery attempts | `5`                     |
| `DISCORD_RETRY_BASE_DELAY_MS`   | Initial backoff                 | `1000`                  |
| `DISCORD_RETRY_MAX_DELAY_MS`    | Backoff ceiling                 | `30000`                 |
| `DISCORD_WEBHOOK_A`             | Demo webhook A                  | required for burst demo |
| `DISCORD_WEBHOOK_B`             | Demo webhook B                  | optional                |

`.env` не коммитится. Полный пример находится в `.env.example`.

## Development checks

```bash
npm ci
npm run lint
npm run format:check
npm run build
npm test
npm run test:e2e
```

Focused webhook tests:

```bash
npx jest src/discord-webhook --runInBand
```

Docker Compose configuration:

```bash
docker compose config
```

## Trade-offs

- Redis + BullMQ выбраны вместо RabbitMQ/Kafka, потому что здесь нужны durable jobs и delayed retry без event-streaming платформы.
- Custom Redis limiter выбран вместо BullMQ Pro group rate limiting: он решает per-channel задачу без платной зависимости.
- Одна queue проще queue-per-channel и не требует динамического управления инфраструктурой.
- At-least-once честнее exactly-once для HTTP webhook без поддержки idempotency на стороне Discord.
- `2/sec` остаётся safety ceiling из тестового задания даже если Discord сообщает другие bucket metadata.

## Production considerations

В полноценной интеграции можно добавить transactional outbox, secret manager/encryption, OpenTelemetry, Prometheus, tracing, alerting, webhook health management и managed Redis. Outbox особенно важен для сценария `DB commit succeeded, queue.add failed`: бизнес-транзакция должна записать событие в outbox, а отдельный publisher отправит его в очередь. PostgreSQL в этот demo намеренно не добавляется.
