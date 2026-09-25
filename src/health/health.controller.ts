import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { QueueStatsService } from '@discord-webhook/application/queue-stats.service';
import { OutboxRepository } from '@outbox/application/outbox.repository';

@Controller('health')
export class HealthController {
  constructor(
    private readonly queueStats: QueueStatsService,
    private readonly outbox: OutboxRepository,
  ) {}

  @Get()
  async check() {
    const [redis, postgres] = await Promise.all([
      this.queueStats.isAvailable(),
      this.outbox.isAvailable(),
    ]);
    if (!redis || !postgres) {
      throw new ServiceUnavailableException({
        status: 'down',
        redis: redis ? 'up' : 'down',
        postgres: postgres ? 'up' : 'down',
      });
    }

    return {
      status: 'ok',
      redis: 'up',
      postgres: 'up',
    };
  }
}
