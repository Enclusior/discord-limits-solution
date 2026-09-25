import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { QueueStatsService } from '@discord-webhook/application/queue-stats.service';

@Controller('health')
export class HealthController {
  constructor(private readonly queueStats: QueueStatsService) {}

  @Get()
  async check() {
    const redis = await this.queueStats.isAvailable();
    if (!redis) {
      throw new ServiceUnavailableException({
        status: 'down',
        redis: 'down',
      });
    }

    return {
      status: 'ok',
      redis: 'up',
    };
  }
}
