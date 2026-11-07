import { Global, Module } from '@nestjs/common';
import { MetricsController } from './metrics.controller';
import { ObservabilityMetrics } from '../../infrastructure/observability/metrics';

@Global()
@Module({
  controllers: [MetricsController],
  providers: [ObservabilityMetrics],
  exports: [ObservabilityMetrics],
})
export class MetricsModule {}
