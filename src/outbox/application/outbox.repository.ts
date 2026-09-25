import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Pool } from 'pg';
import { DiscordWebhookJob } from '@discord-webhook/domain/discord-webhook-job';
import { POSTGRES_POOL } from '../infrastructure/postgres.provider';

@Injectable()
export class OutboxRepository implements OnModuleInit, OnModuleDestroy {
  constructor(@Inject(POSTGRES_POOL) private readonly pool: Pool) {}

  async onModuleInit(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS webhook_outbox_events (
        event_id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        webhook_url TEXT NOT NULL,
        payload JSONB NOT NULL,
        metadata JSONB,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'publishing', 'published')),
        attempts INTEGER NOT NULL DEFAULT 0,
        available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        locked_until TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        published_at TIMESTAMPTZ,
        last_error TEXT
      );
      CREATE INDEX IF NOT EXISTS webhook_outbox_pending_idx
        ON webhook_outbox_events (status, available_at);
    `);
  }

  async insertPendingEvent(job: DiscordWebhookJob): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO webhook_outbox_events
          (event_id, channel_id, webhook_url, payload, metadata, created_at)
        VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)
        ON CONFLICT (event_id) DO NOTHING
      `,
      [
        job.eventId,
        job.channelId,
        job.webhookUrl,
        JSON.stringify(job.payload),
        job.metadata ? JSON.stringify(job.metadata) : null,
        job.createdAt,
      ],
    );
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async claimBatch(limit: number, leaseMs: number): Promise<OutboxRecord[]> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<OutboxRecord>(
        `
          SELECT event_id, channel_id, webhook_url, payload, metadata,
                 created_at, attempts
          FROM webhook_outbox_events
          WHERE (status = 'pending' AND available_at <= NOW())
             OR (status = 'publishing' AND locked_until < NOW())
          ORDER BY created_at
          FOR UPDATE SKIP LOCKED
          LIMIT $1
        `,
        [limit],
      );
      const eventIds = result.rows.map((row) => row.event_id);
      if (eventIds.length) {
        await client.query(
          `
            UPDATE webhook_outbox_events
            SET status = 'publishing',
                locked_until = NOW() + ($1 * INTERVAL '1 millisecond'),
                attempts = attempts + 1
            WHERE event_id = ANY($2::text[])
          `,
          [leaseMs, eventIds],
        );
      }
      await client.query('COMMIT');
      return result.rows;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async markPublished(eventId: string): Promise<void> {
    await this.pool.query(
      `
        UPDATE webhook_outbox_events
        SET status = 'published', published_at = NOW(), locked_until = NULL
        WHERE event_id = $1
      `,
      [eventId],
    );
  }

  async markForRetry(eventId: string, error: Error): Promise<void> {
    await this.pool.query(
      `
        UPDATE webhook_outbox_events
        SET status = 'pending',
            available_at = NOW() + INTERVAL '1 second',
            locked_until = NULL,
            last_error = $2
        WHERE event_id = $1
      `,
      [eventId, error.message.slice(0, 1000)],
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}

export interface OutboxRecord {
  event_id: string;
  channel_id: string;
  webhook_url: string;
  payload: DiscordWebhookJob['payload'];
  metadata: DiscordWebhookJob['metadata'];
  created_at: string;
  attempts: number;
}
