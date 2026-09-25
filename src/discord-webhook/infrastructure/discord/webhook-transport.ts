import { DiscordWebhookPayload } from '@discord-webhook/domain/discord-webhook-payload';
import { DiscordHttpResponse } from './discord-response-classifier';

export const WEBHOOK_TRANSPORT = Symbol('WEBHOOK_TRANSPORT');

export interface WebhookTransport {
  send(
    webhookUrl: string,
    payload: DiscordWebhookPayload,
  ): Promise<DiscordHttpResponse>;
}
