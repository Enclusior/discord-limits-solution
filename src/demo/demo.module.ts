import { Module } from '@nestjs/common';
import { DiscordWebhookModule } from '../discord-webhook/discord-webhook.module';
import { QueueStatsService } from '../discord-webhook/application/queue-stats.service';
import { DemoController } from './demo.controller';

@Module({
  imports: [DiscordWebhookModule],
  controllers: [DemoController],
  providers: [QueueStatsService],
})
export class DemoModule {}
