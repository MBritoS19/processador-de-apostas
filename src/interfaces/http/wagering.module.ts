import { Module } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { OpenWallet } from '../../application/wallets/open-wallet';
import { ReconcileWallet } from '../../application/wallets/reconcile-wallet';
import { PostgresWalletReconciliationReader } from '../../infrastructure/persistence/postgres-wallet-reconciliation.reader';
import { InstrumentedProcessWagerTransaction } from '../../infrastructure/observability/instrumented-process-wager-transaction';
import { ObservabilityMetrics } from '../../infrastructure/observability/metrics';
import { WageringCoreModule } from '../../infrastructure/wagering-core.module';
import { AuthGuard } from './auth.guard';
import { WageringController } from './wagering.controller';
import { WageringHttpService } from './wagering-http.service';

@Module({
  imports: [WageringCoreModule],
  controllers: [WageringController],
  providers: [
    AuthGuard,
    {
      provide: ReconcileWallet,
      inject: [EntityManager],
      useFactory: (em: EntityManager) => new ReconcileWallet(new PostgresWalletReconciliationReader(em)),
    },
    {
      provide: WageringHttpService,
      inject: [EntityManager, InstrumentedProcessWagerTransaction, OpenWallet, ReconcileWallet, ObservabilityMetrics],
      useFactory: (
        em: EntityManager,
        process: InstrumentedProcessWagerTransaction,
        openWallet: OpenWallet,
        reconcileWallet: ReconcileWallet,
        metrics: ObservabilityMetrics,
      ) => new WageringHttpService(em, process, openWallet, reconcileWallet, metrics),
    },
  ],
})
export class WageringModule {}
