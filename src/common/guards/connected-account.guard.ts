import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../modules/prisma/prisma.service';
import { REQUIRE_CONNECTED_ACCOUNT } from '../decorators/require-connected-account.decorator';
import type { AuthUser } from '../decorators/current-user.decorator';

/**
 * Bloqueia rotas anotadas com @RequireConnectedAccount() quando o usuário não
 * tem nenhuma conta da Meta conectada. Roda após o JwtAuthGuard (req.user já
 * existe).
 */
@Injectable()
export class ConnectedAccountGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<boolean>(
      REQUIRE_CONNECTED_ACCOUNT,
      [context.getHandler(), context.getClass()],
    );
    if (!required) return true;

    const req = context.switchToHttp().getRequest<{ user?: AuthUser }>();
    const userId = req.user?.id;
    if (!userId) return false;

    const count = await this.prisma.connectedAccount.count({
      where: { userId, status: 'connected' },
    });
    if (count === 0) {
      throw new ForbiddenException(
        'Conecte uma conta do Instagram antes de criar ou ativar automações.',
      );
    }
    return true;
  }
}
