import { Module } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { OpenWallet } from '../../application/wallets/open-wallet';
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
      provide: WageringHttpService,
      inject: [EntityManager, InstrumentedProcessWagerTransaction, OpenWallet, ObservabilityMetrics],
      useFactory: (
        em: EntityManager,
        process: InstrumentedProcessWagerTransaction,
        openWallet: OpenWallet,
        metrics: ObservabilityMetrics,
      ) => new WageringHttpService(em, process, openWallet, metrics),
    },
  ],
})
export class WageringModule {}
