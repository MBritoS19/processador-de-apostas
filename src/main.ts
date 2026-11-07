import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadConfig } from './infrastructure/config/app-config';
import { PinoNestLogger } from './infrastructure/observability/logger';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await NestFactory.create(AppModule.register(config), { logger: new PinoNestLogger() });

  // SIGTERM/SIGINT disparam onModuleDestroy/onApplicationShutdown (pool do ORM, consumidores).
  app.enableShutdownHooks();

  await app.listen(config.httpPort);
  Logger.log(`HTTP escutando na porta ${config.httpPort}`, 'Bootstrap');
}

bootstrap().catch((error: unknown) => {
  process.stderr.write(`Falha no boot: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
