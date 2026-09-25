import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import configuration from './config/configuration';
import { environmentValidationSchema } from './config/env.validation';
import { DiscordWebhookModule } from './discord-webhook/discord-webhook.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validationSchema: environmentValidationSchema,
    }),
    DiscordWebhookModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
