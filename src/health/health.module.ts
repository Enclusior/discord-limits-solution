import { Module } from '@nestjs/common';
import { DiscordWebhookModule } from '../discord-webhook/discord-webhook.module';
import { QueueStatsService } from '../discord-webhook/application/queue-stats.service';
import { HealthController } from './health.controller';

@Module({
  imports: [DiscordWebhookModule],
  controllers: [HealthController],
  providers: [QueueStatsService],
})
export class HealthModule {}
