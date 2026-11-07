import { Inject, Module, type BeforeApplicationShutdown, type OnApplicationBootstrap } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { ResolvePendingReferences } from '../../application/wagering/resolve-pending-references';
import { WagerSettlement } from '../../application/wagering/wager-settlement';
import { APP_CONFIG, type AppConfig } from '../../infrastructure/config/app-config';
import { ObservabilityMetrics } from '../../infrastructure/observability/metrics';
import { MikroOrmWagerUnitOfWork } from '../../infrastructure/persistence/mikro-orm-wager-unit-of-work';
import { randomIdGenerator, systemClock } from '../../infrastructure/system-adapters';
import { PendingReferenceWorker } from './pending-reference-worker';

/**
 * Liga o worker quando `PENDING_REFERENCE_WORKER_ENABLED=true`. Para em `beforeApplicationShutdown`,
 * antes de o ORM fechar: a candidata em andamento commita dentro do grace period.
 */
@Module({
  providers: [
    {
      provide: PendingReferenceWorker,
      inject: [EntityManager, ObservabilityMetrics, APP_CONFIG],
      useFactory: (em: EntityManager, metrics: ObservabilityMetrics, config: AppConfig) => {
        const { workerEnabled: _enabled, ttlMs, ...options } = config.pendingReferences;
        const resolver = new ResolvePendingReferences(
          new MikroOrmWagerUnitOfWork(em),
          systemClock,
          new WagerSettlement(randomIdGenerator, ttlMs),
        );
        return new PendingReferenceWorker(resolver, metrics, options);
      },
    },
  ],
  exports: [PendingReferenceWorker],
})
export class PendingReferenceWorkerModule implements OnApplicationBootstrap, BeforeApplicationShutdown {
  constructor(
    @Inject(PendingReferenceWorker) private readonly worker: PendingReferenceWorker,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.pendingReferences.workerEnabled) this.worker.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.worker.stop();
  }
}
