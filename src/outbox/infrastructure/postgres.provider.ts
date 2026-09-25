import { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';

export const POSTGRES_POOL = Symbol('POSTGRES_POOL');

export const postgresProvider: Provider = {
  provide: POSTGRES_POOL,
  inject: [ConfigService],
  useFactory: (config: ConfigService): Pool =>
    new Pool({
      host: config.getOrThrow<string>('postgres.host'),
      port: config.getOrThrow<number>('postgres.port'),
      database: config.getOrThrow<string>('postgres.database'),
      user: config.getOrThrow<string>('postgres.user'),
      password: config.getOrThrow<string>('postgres.password'),
      max: config.getOrThrow<number>('postgres.poolSize'),
    }),
};
