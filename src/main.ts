import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadConfig } from './infrastructure/config/app-config';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await NestFactory.create(AppModule.register(config));

  // SIGTERM/SIGINT disparam onModuleDestroy/onApplicationShutdown (pool do ORM, consumidores).
  app.enableShutdownHooks();

  await app.listen(config.httpPort);
  Logger.log(`HTTP escutando na porta ${config.httpPort}`, 'Bootstrap');
}

bootstrap().catch((error: unknown) => {
  process.stderr.write(`Falha no boot: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
