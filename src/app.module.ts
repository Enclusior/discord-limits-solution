import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import configuration from '@config/configuration';
import { environmentValidationSchema } from '@config/env.validation';
import { DemoModule } from '@demo/demo.module';
import { DiscordWebhookModule } from '@discord-webhook/discord-webhook.module';
import { HealthModule } from '@health/health.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validationSchema: environmentValidationSchema,
    }),
    DiscordWebhookModule,
    DemoModule,
    HealthModule,
  ],
})
export class AppModule {}
