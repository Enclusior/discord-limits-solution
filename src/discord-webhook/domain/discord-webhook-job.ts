import { DiscordWebhookPayload } from './discord-webhook-payload';

/** Слот в расписании канала и сдвиг расписания на момент резервации. */
export interface SlotReservation {
  slotAt: number;
  shift: number;
}

export interface DiscordWebhookJob {
  eventId: string;
  channelId: string;
  webhookUrl: string;
  payload: DiscordWebhookPayload;
  createdAt: string;
  /** Неудачные HTTP-попытки (кроме 429), влияют на backoff. */
  deliveryAttempts?: number;
  /** Сколько раз задача была переотложена; входит в детерминированный jobId. */
  rescheduleCount?: number;
  reservation?: SlotReservation;
  metadata?: Record<string, string>;
}

export interface DeliveryReceipt {
  deliveredAt: string;
  statusCode: number;
}

export interface EnqueueWebhookInput {
  eventId: string;
  channelId: string;
  webhookUrl: string;
  payload: DiscordWebhookPayload;
  metadata?: Record<string, string>;
}
