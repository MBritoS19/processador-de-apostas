import { Module } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { ProcessWagerTransaction } from '../application/wagering/process-wager-transaction';
import { WagerSettlement } from '../application/wagering/wager-settlement';
import { OpenWallet } from '../application/wallets/open-wallet';
import { APP_CONFIG, type AppConfig } from './config/app-config';
import { InstrumentedProcessWagerTransaction } from './observability/instrumented-process-wager-transaction';
import { LoggingLockConflictTelemetry } from './observability/lock-conflict-telemetry';
import { ObservabilityMetrics } from './observability/metrics';
import { MikroOrmWagerUnitOfWork } from './persistence/mikro-orm-wager-unit-of-work';
import { randomIdGenerator, systemClock } from './system-adapters';

/** Monta o use case instrumentado. Exportada para testes que embrulham o processamento. */
export function buildInstrumentedProcess(
  em: EntityManager,
  metrics: ObservabilityMetrics,
  referenceTtlMs: number,
): InstrumentedProcessWagerTransaction {
  const telemetry = new LoggingLockConflictTelemetry(metrics);
  const settlement = new WagerSettlement(randomIdGenerator, referenceTtlMs);
  return new InstrumentedProcessWagerTransaction(
    new ProcessWagerTransaction(new MikroOrmWagerUnitOfWork(em), systemClock, randomIdGenerator, telemetry, settlement),
    metrics,
  );
}

/** Use cases compartilhados pelas entradas HTTP e SQS: mesmas regras, mesmas métricas. */
@Module({
  providers: [
    {
      provide: InstrumentedProcessWagerTransaction,
      inject: [EntityManager, ObservabilityMetrics, APP_CONFIG],
      useFactory: (em: EntityManager, metrics: ObservabilityMetrics, config: AppConfig) =>
        buildInstrumentedProcess(em, metrics, config.pendingReferences.ttlMs),
    },
    {
      provide: OpenWallet,
      inject: [EntityManager],
      useFactory: (em: EntityManager) => new OpenWallet(new MikroOrmWagerUnitOfWork(em), systemClock, randomIdGenerator),
    },
  ],
  exports: [InstrumentedProcessWagerTransaction, OpenWallet],
})
export class WageringCoreModule {}
