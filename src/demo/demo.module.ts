import { Module } from '@nestjs/common';
import { QueueStatsService } from '@discord-webhook/application/queue-stats.service';
import { DiscordWebhookModule } from '@discord-webhook/discord-webhook.module';
import { DemoController } from './demo.controller';

@Module({
  imports: [DiscordWebhookModule],
  controllers: [DemoController],
  providers: [QueueStatsService],
})
export class DemoModule {}
