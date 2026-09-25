import { Inject, Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
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
    @Inject(WEBHOOK_QUEUE) private readonly queue: Queue,
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
    const jobsByEventId = new Map(
      runJobs.map((job) => [job.data.eventId, job]),
    );
    const uniqueRunJobs = [...jobsByEventId.values()];
    const completed = uniqueRunJobs
      .filter((job) => job.finishedOn)
      .filter((job) => {
        return job.data.deliveredAt !== undefined;
      });
    const failed = uniqueRunJobs.filter((job) => job.failedReason);
    const pending = uniqueRunJobs.filter((job) => !job.finishedOn).length;
    const runDlxJobs = dlxJobs.filter(
      (job) => job.data.metadata?.runId === runId,
    );
    const deliveryDurations = completed.flatMap((job) => {
      const createdAt = Date.parse(job.data.createdAt);
      const deliveredAt = Date.parse(job.data.deliveredAt ?? '');
      return Number.isFinite(createdAt) && Number.isFinite(deliveredAt)
        ? [deliveredAt - createdAt]
        : [];
    });

    return {
      produced: uniqueRunJobs.length,
      completed: completed.length,
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
