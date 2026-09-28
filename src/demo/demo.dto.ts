import {
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import type { EnqueueWebhookInput } from '@discord-webhook/domain/discord-webhook-job';
import type { DiscordWebhookPayload } from '@discord-webhook/domain/discord-webhook-payload';

// Принимаем только адреса Discord Webhook API, чтобы сервис нельзя было
// использовать для запросов на произвольные хосты.
export const DISCORD_WEBHOOK_URL =
  /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/[^/\s]+\/[^/\s?#]+$/;
const WEBHOOK_URL_MESSAGE = 'webhookUrl must be a Discord webhook URL';

export class EnqueueWebhookDto implements EnqueueWebhookInput {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  eventId: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  channelId: string;

  @Matches(DISCORD_WEBHOOK_URL, { message: WEBHOOK_URL_MESSAGE })
  webhookUrl: string;

  @IsObject()
  payload: DiscordWebhookPayload;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, string>;
}

export class BurstDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  count?: number;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  channelId?: string;

  @IsOptional()
  @Matches(DISCORD_WEBHOOK_URL, { message: WEBHOOK_URL_MESSAGE })
  webhookUrl?: string;

  @IsOptional()
  @IsString()
  runId?: string;
}

export class BurstBothDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  count?: number;

  @IsOptional()
  @IsString()
  runId?: string;
}

export class LoadSummaryDto {
  @IsString()
  @IsNotEmpty()
  runId: string;

  @IsString()
  summary: string;
}
