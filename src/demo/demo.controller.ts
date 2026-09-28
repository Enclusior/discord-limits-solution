import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Query,
} from '@nestjs/common';
import { EnqueueWebhookService } from '@discord-webhook/application/enqueue-webhook.service';
import { QueueStatsService } from '@discord-webhook/application/queue-stats.service';
import {
  BurstBothDto,
  BurstDto,
  EnqueueWebhookDto,
  LoadSummaryDto,
} from './demo.dto';

@Controller('demo')
export class DemoController {
  constructor(
    private readonly enqueueService: EnqueueWebhookService,
    private readonly statsService: QueueStatsService,
  ) {}

  @Post('webhook')
  enqueue(@Body() input: EnqueueWebhookDto) {
    return this.enqueueService.enqueue(input);
  }

  @Post('burst')
  async burst(@Body() body: BurstDto) {
    const count = body.count ?? 10;
    const channelId = body.channelId ?? 'demo-channel';
    const webhookUrl = this.resolveWebhookUrl(
      body.webhookUrl ?? process.env.DISCORD_WEBHOOK_A,
      'DISCORD_WEBHOOK_A',
    );
    const jobs = await Promise.all(
      Array.from({ length: count }, (_, index) =>
        this.enqueueService.enqueue({
          eventId: `demo-${channelId}-${Date.now()}-${index}`,
          channelId,
          webhookUrl,
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
  async burstBoth(@Body() body: BurstBothDto) {
    const webhookUrlB = this.resolveWebhookUrl(
      process.env.DISCORD_WEBHOOK_B,
      'DISCORD_WEBHOOK_B',
    );
    const [channelA, channelB] = await Promise.all([
      this.burst({
        count: body.count,
        channelId: 'demo-channel-a',
        runId: body.runId,
      }),
      this.burst({
        count: body.count,
        channelId: 'demo-channel-b',
        webhookUrl: webhookUrlB,
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
  loadSummary(@Body() body: LoadSummaryDto) {
    return this.enqueueService.enqueue({
      eventId: `load-summary-${body.runId}`,
      channelId: `load-summary-${body.runId}`,
      webhookUrl: this.resolveWebhookUrl(
        process.env.DISCORD_WEBHOOK_A,
        'DISCORD_WEBHOOK_A',
      ),
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

  private resolveWebhookUrl(url: string | undefined, envName: string): string {
    if (!url) {
      throw new BadRequestException(`${envName} is not configured`);
    }
    return url;
  }
}
