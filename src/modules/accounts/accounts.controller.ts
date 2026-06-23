import { Controller, Get, Logger, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AccountsService } from './accounts.service';
import type { MetaProvider } from '../meta/graph.service';
import { Platform } from '@generated/prisma/enums';
import { Public } from '../../common/decorators/public.decorator';
import {
  CurrentUser,
  type AuthUser,
} from '../../common/decorators/current-user.decorator';

function normalizeProvider(value?: string): MetaProvider {
  return value === 'facebook' ? 'facebook' : 'instagram';
}

@ApiTags('accounts')
@Controller('accounts')
export class AccountsController {
  private readonly logger = new Logger(AccountsController.name);

  constructor(private readonly service: AccountsService) {}

  @Get('status')
  @ApiBearerAuth()
  status(@CurrentUser() user: AuthUser) {
    return this.service.status(user.id);
  }

  @Get('media')
  @ApiBearerAuth()
  media(@CurrentUser() user: AuthUser) {
    return this.service.listMedia(user.id);
  }

  @Post('connect')
  @ApiBearerAuth()
  connect(@CurrentUser() user: AuthUser, @Query('provider') provider?: string) {
    return this.service.startOAuth(user.id, normalizeProvider(provider));
  }

  @Post('disconnect/:platform')
  @ApiBearerAuth()
  disconnect(
    @CurrentUser() user: AuthUser,
    @Param('platform') platform: Platform,
  ) {
    return this.service.disconnect(user.id, platform);
  }

  /**
   * Callback público chamado pela Meta após o consentimento.
   * O provider vem no query (definido no redirect_uri de cada fluxo).
   */
  @Public()
  @Get('callback')
  async callback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('provider') provider: string,
    @Res() res: Response,
  ) {
    const frontend = process.env.FRONTEND_URL ?? 'http://localhost:5173';
    try {
      await this.service.handleCallback(
        normalizeProvider(provider),
        code,
        state,
      );
      return res.redirect(`${frontend}/configuracoes?connected=1`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // Loga a causa real (visível nos logs do Railway) e repassa um resumo
      // seguro ao frontend para exibição.
      this.logger.error(`Falha no callback OAuth (${provider}): ${reason}`);
      const summary = encodeURIComponent(reason.slice(0, 180));
      return res.redirect(`${frontend}/configuracoes?error=1&reason=${summary}`);
    }
  }
}
