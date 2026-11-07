import { Body, Controller, Get, Headers, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { AuthGuard } from './auth.guard';
import { WageringHttpService, type HttpResult } from './wagering-http.service';

/** Erros sobem como `ApiError` e são renderizados pelo `ApiExceptionFilter` global. */
@UseGuards(AuthGuard)
@Controller()
export class WageringController {
  constructor(private readonly service: WageringHttpService) {}

  @Post('wallets')
  async createWallet(
    @Body() body: unknown,
    @Headers('x-correlation-id') correlationId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Record<string, unknown>> {
    return send(res, await this.service.createWallet(body, correlationId));
  }

  @Post('wagering/transactions')
  async submit(
    @Headers('idempotency-key') key: unknown,
    @Headers('x-correlation-id') correlationId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Record<string, unknown>> {
    return send(res, await this.service.submit(key, correlationId, body));
  }

  @Get('wallets/:id')
  async wallet(@Param('id') id: string, @Res({ passthrough: true }) res: Response): Promise<Record<string, unknown>> {
    return send(res, await this.service.findWallet(id));
  }

  @Get('wagering/transactions/:id')
  async transaction(@Param('id') id: string, @Res({ passthrough: true }) res: Response): Promise<Record<string, unknown>> {
    return send(res, await this.service.findTransaction(id));
  }

  @Get('providers/:providerId/wagering/transactions/:externalId')
  async providerTransaction(
    @Param('providerId') providerId: string,
    @Param('externalId') externalId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Record<string, unknown>> {
    return send(res, await this.service.findProviderTransaction(providerId, externalId));
  }

  @Get('wallets/:id/ledger')
  async ledger(
    @Param('id') id: string,
    @Query('cursor') cursor: unknown,
    @Query('limit') limit: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Record<string, unknown>> {
    return send(res, await this.service.ledger(id, cursor, limit));
  }

  @Post('wallets/:id/reconciliation')
  async reconciliation(
    @Param('id') id: string,
    @Headers('x-correlation-id') correlationId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Record<string, unknown>> {
    return send(res, await this.service.reconcile(id, correlationId));
  }
}

function send(res: Response, result: HttpResult): Record<string, unknown> {
  res.status(result.status);
  return result.body;
}
