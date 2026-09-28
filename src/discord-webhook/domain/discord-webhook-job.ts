import { DiscordWebhookPayload } from './discord-webhook-payload';

export interface DiscordWebhookJob {
  eventId: string;
  channelId: string;
  webhookUrl: string;
  payload: DiscordWebhookPayload;
  createdAt: string;
  deliveryAttempts?: number;
  reservedAt?: number;
  reservationEpoch?: number;
  deliveredAt?: string;
  metadata?: Record<string, string>;
}

export interface EnqueueWebhookInput {
  eventId: string;
  channelId: string;
  webhookUrl: string;
  payload: DiscordWebhookPayload;
  metadata?: Record<string, string>;
}
