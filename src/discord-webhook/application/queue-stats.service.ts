import { Inject, Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import {
  WEBHOOK_DLX_QUEUE,
  WEBHOOK_QUEUE,
} from '../infrastructure/queue/queue.providers';

export interface QueueStats {
  waiting: number;
  active: number;
  delayed: number;
  completed: number;
  failed: number;
  dlxWaiting: number;
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
}
