import { Module } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { OpenWallet } from '../../application/wallets/open-wallet';
import { ProcessWagerTransaction } from '../../application/wagering/process-wager-transaction';
import { InstrumentedProcessWagerTransaction } from '../../infrastructure/observability/instrumented-process-wager-transaction';
import { LoggingLockConflictTelemetry } from '../../infrastructure/observability/lock-conflict-telemetry';
import { ObservabilityMetrics } from '../../infrastructure/observability/metrics';
import { MikroOrmWagerUnitOfWork } from '../../infrastructure/persistence/mikro-orm-wager-unit-of-work';
import { randomIdGenerator, systemClock } from '../../infrastructure/system-adapters';
import { AuthGuard } from './auth.guard';
import { WageringController } from './wagering.controller';
import { WageringHttpService } from './wagering-http.service';

@Module({
  controllers: [WageringController],
  providers: [
    AuthGuard,
    {
      provide: WageringHttpService,
      inject: [EntityManager, ObservabilityMetrics],
      useFactory: (em: EntityManager, metrics: ObservabilityMetrics) => {
        const unitOfWork = new MikroOrmWagerUnitOfWork(em);
        const telemetry = new LoggingLockConflictTelemetry(undefined, metrics);
        const process = new InstrumentedProcessWagerTransaction(
          new ProcessWagerTransaction(unitOfWork, systemClock, randomIdGenerator, telemetry),
          metrics,
        );
        return new WageringHttpService(em, process, new OpenWallet(unitOfWork, systemClock, randomIdGenerator), metrics);
      },
    },
  ],
})
export class WageringModule {}
