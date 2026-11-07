import { Controller, Get, Header } from '@nestjs/common';
import { ObservabilityMetrics } from '../../infrastructure/observability/metrics';

@Controller()
export class MetricsController {
  constructor(private readonly metrics: ObservabilityMetrics) {}

  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async metricsText(): Promise<string> {
    return this.metrics.registry.metrics();
  }
}
