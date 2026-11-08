import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ReadinessService, type ReadinessReport } from '../../../application/health/readiness.service';

/** Health checks. Abertos por definição (CHALLENGE §2 e §9). Contrato em ARCHITECTURE.md → "Observabilidade". */
@Controller('health')
export class HealthController {
  constructor(private readonly readiness: ReadinessService) {}

  /** Liveness: o processo responde. Não toca dependências, para não ser reiniciado por falha alheia. */
  @Get('live')
  live(): { status: 'alive' } {
    return { status: 'alive' };
  }

  /** Readiness: Postgres e SQS alcançáveis dentro do timeout. 503 se qualquer um falhar. */
  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response): Promise<ReadinessReport> {
    const report = await this.readiness.evaluate();
    res.status(report.status === 'ready' ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return report;
  }
}
