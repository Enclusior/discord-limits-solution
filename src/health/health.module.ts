import { Module } from '@nestjs/common';
import { QueueStatsService } from '@discord-webhook/application/queue-stats.service';
import { DiscordWebhookModule } from '@discord-webhook/discord-webhook.module';
import { HealthController } from './health.controller';

@Module({
  imports: [DiscordWebhookModule],
  controllers: [HealthController],
  providers: [QueueStatsService],
})
export class HealthModule {}
