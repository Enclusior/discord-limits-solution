import { Inject, Injectable } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import {
  DeliveryReceipt,
  DiscordWebhookJob,
} from '@discord-webhook/domain/discord-webhook-job';
import {
  WEBHOOK_DLX_QUEUE,
  WEBHOOK_QUEUE,
} from '@discord-webhook/infrastructure/queue/queue.providers';

export interface QueueStats {
  waiting: number;
  active: number;
  delayed: number;
  completed: number;
  failed: number;
  dlxWaiting: number;
}

export interface RunStats {
  produced: number;
  completed: number;
  failed: number;
  pending: number;
  dlxWaiting: number;
  averageDeliveryMs: number | null;
}

@Injectable()
export class QueueStatsService {
  constructor(
    @Inject(WEBHOOK_QUEUE) private readonly queue: Queue<DiscordWebhookJob>,
    @Inject(WEBHOOK_DLX_QUEUE) private readonly dlxQueue: Queue,
  ) {}

  async getStats(): Promise<QueueStats> {
    const [counts, dlxCounts] = await Promise.all([
      this.queue.getJobCounts(
        'waiting',
        'active',
        'delayed',
        'completed',
        'failed',
      ),
      this.dlxQueue.getJobCounts('waiting'),
    ]);

    return {
      waiting: counts.waiting ?? 0,
      active: counts.active ?? 0,
      delayed: counts.delayed ?? 0,
      completed: counts.completed ?? 0,
      failed: counts.failed ?? 0,
      dlxWaiting: dlxCounts.waiting ?? 0,
    };
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.queue.getJobCounts('waiting');
      return true;
    } catch {
      return false;
    }
  }

  async getRunStats(runId: string): Promise<RunStats> {
    const [jobs, dlxJobs] = await Promise.all([
      this.queue.getJobs(
        ['waiting', 'active', 'delayed', 'completed', 'failed'],
        0,
        -1,
        true,
      ),
      this.dlxQueue.getJobs(['waiting'], 0, -1, true),
    ]);
    const runJobs = jobs.filter((job) => job.data.metadata?.runId === runId);
    // У одного события несколько задач (каждый перенос - новая задача):
    // состояние события - это состояние последней из них.
    const latestByEventId = new Map<string, Job<DiscordWebhookJob>>();
    for (const job of runJobs) {
      const current = latestByEventId.get(job.data.eventId);
      if (
        !current ||
        (job.data.rescheduleCount ?? 0) > (current.data.rescheduleCount ?? 0)
      ) {
        latestByEventId.set(job.data.eventId, job);
      }
    }
    const events = [...latestByEventId.values()];
    const delivered = events.flatMap((job) => {
      const receipt = job.returnvalue as DeliveryReceipt | null | undefined;
      return job.finishedOn && receipt?.deliveredAt
        ? [{ job, deliveredAt: receipt.deliveredAt }]
        : [];
    });
    const failed = events.filter((job) => job.failedReason && job.finishedOn);
    const pending = events.filter((job) => !job.finishedOn).length;
    const runDlxJobs = dlxJobs.filter(
      (job) => job.data.metadata?.runId === runId,
    );
    const deliveryDurations = delivered.flatMap(({ job, deliveredAt }) => {
      const duration = Date.parse(deliveredAt) - Date.parse(job.data.createdAt);
      return Number.isFinite(duration) ? [duration] : [];
    });

    return {
      produced: events.length,
      completed: delivered.length,
      failed: failed.length + runDlxJobs.length,
      pending,
      dlxWaiting: runDlxJobs.length,
      averageDeliveryMs: deliveryDurations.length
        ? Math.round(
            deliveryDurations.reduce((total, duration) => total + duration, 0) /
              deliveryDurations.length,
          )
        : null,
    };
  }
}
