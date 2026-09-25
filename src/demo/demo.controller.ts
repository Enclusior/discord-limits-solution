import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { EnqueueWebhookService } from '@discord-webhook/application/enqueue-webhook.service';
import { QueueStatsService } from '@discord-webhook/application/queue-stats.service';
import type { EnqueueWebhookInput } from '@discord-webhook/domain/discord-webhook-job';

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
    @Body()
    body: {
      count?: number;
      channelId?: string;
      webhookUrl?: string;
      runId?: string;
    },
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
          metadata: body.runId ? { runId: body.runId } : undefined,
        }),
      ),
    );

    return { channelId, count: jobs.length, jobs };
  }

  @Post('burst-both')
  async burstBoth(@Body() body: { count?: number; runId?: string }) {
    const count = Math.min(Math.max(body.count ?? 10, 1), 1000);
    const [channelA, channelB] = await Promise.all([
      this.burst({
        count,
        channelId: 'demo-channel-a',
        runId: body.runId,
      }),
      this.burst({
        count,
        channelId: 'demo-channel-b',
        webhookUrl: process.env.DISCORD_WEBHOOK_B,
        runId: body.runId,
      }),
    ]);

    return { channelA, channelB };
  }

  @Get('queue-status')
  queueStatus(@Query('runId') runId?: string) {
    return runId
      ? this.statsService.getRunStats(runId)
      : this.statsService.getStats();
  }

  @Post('load-summary')
  loadSummary(@Body() body: { runId: string; summary: string }) {
    return this.enqueueService.enqueue({
      eventId: `load-summary-${body.runId}`,
      channelId: `load-summary-${body.runId}`,
      webhookUrl: process.env.DISCORD_WEBHOOK_A ?? '',
      payload: {
        embeds: [
          {
            title: 'Webhook load test completed',
            description: body.summary,
          },
        ],
      },
      metadata: { summary: 'true' },
    });
  }
}
