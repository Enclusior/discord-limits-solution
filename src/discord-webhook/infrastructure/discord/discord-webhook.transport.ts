import { Injectable } from '@nestjs/common';
import axios, { AxiosError } from 'axios';
import { DiscordWebhookPayload } from '../../domain/discord-webhook-payload';
import { DiscordHttpResponse } from './discord-response-classifier';
import { WebhookTransport } from './webhook-transport';

@Injectable()
export class DiscordWebhookTransport implements WebhookTransport {
  async send(
    webhookUrl: string,
    payload: DiscordWebhookPayload,
  ): Promise<DiscordHttpResponse> {
    try {
      const response = await axios.post(webhookUrl, payload, {
        timeout: Number(process.env.DISCORD_REQUEST_TIMEOUT_MS ?? 10000),
        validateStatus: () => true,
      });

      return {
        statusCode: response.status,
        headers: this.normalizeHeaders(response.headers),
        body: response.data,
      };
    } catch (error) {
      if (error instanceof AxiosError) {
        throw new Error(
          `Discord transport failed: ${error.code ?? 'unknown'}`,
          { cause: error },
        );
      }

      throw error;
    }
  }

  private normalizeHeaders(
    headers: Record<string, unknown>,
  ): Record<string, string | undefined> {
    return Object.fromEntries(
      Object.entries(headers).map(([key, value]) => [
        key.toLowerCase(),
        Array.isArray(value) ? value[0] : value?.toString(),
      ]),
    );
  }
}
