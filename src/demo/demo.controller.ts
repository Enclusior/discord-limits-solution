import { Body, Controller, Get, Post } from '@nestjs/common';
import { EnqueueWebhookService } from '../discord-webhook/application/enqueue-webhook.service';
import { QueueStatsService } from '../discord-webhook/application/queue-stats.service';
import type { EnqueueWebhookInput } from '../discord-webhook/domain/discord-webhook-job';

@Controller('demo')
export class DemoController {
  constructor(
    private readonly enqueueService: EnqueueWebhookService,
    private readonly statsService: QueueStatsService,
  ) {}

  @Post('webhook')
  enqueue(@Body() input: EnqueueWebhookInput) {
    return this.enqueueService.enqueue(input);
  }

  @Post('burst')
  async burst(
    @Body() body: { count?: number; channelId?: string; webhookUrl?: string },
  ) {
    const count = Math.min(Math.max(body.count ?? 10, 1), 1000);
    const channelId = body.channelId ?? 'demo-channel';
    const jobs = await Promise.all(
      Array.from({ length: count }, (_, index) =>
        this.enqueueService.enqueue({
          eventId: `demo:${channelId}:${Date.now()}:${index}`,
          channelId,
          webhookUrl: body.webhookUrl ?? process.env.DISCORD_WEBHOOK_A ?? '',
          payload: {
            embeds: [
              {
                title: 'Discord webhook demo',
                description: `Event ${index + 1} of ${count}`,
              },
            ],
          },
        }),
      ),
    );

    return { channelId, count: jobs.length, jobs };
  }

  @Post('burst-both')
  async burstBoth(@Body() body: { count?: number }) {
    const count = Math.min(Math.max(body.count ?? 10, 1), 1000);
    const [channelA, channelB] = await Promise.all([
      this.burst({ count, channelId: 'demo-channel-a' }),
      this.burst({
        count,
        channelId: 'demo-channel-b',
        webhookUrl: process.env.DISCORD_WEBHOOK_B,
      }),
    ]);

    return { channelA, channelB };
  }

  @Get('queue-status')
  queueStatus() {
    return this.statsService.getStats();
  }
}
