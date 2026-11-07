import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';

@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    // Ponto de extensão para autenticação do provider; a Fase 4 não define credenciais.
    return true;
  }
}
