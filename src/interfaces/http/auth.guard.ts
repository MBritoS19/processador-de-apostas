import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';

@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    // Ponto de extensão da autenticação do provider (não implementada; desenho em ARCHITECTURE.md → "Autenticação").
    return true;
  }
}
