import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { GraphService, type MetaProvider } from '../meta/graph.service';
import {
  decryptSecret,
  deriveKey,
  encryptSecret,
} from '../../common/crypto/secrets.crypto';
import { ConnectionStatus, Platform } from '@generated/prisma/enums';

@Injectable()
export class AccountsService {
  private readonly logger = new Logger(AccountsService.name);
  private readonly key = deriveKey(
    process.env.INTEGRATION_ENC_KEY ?? 'dev-integration-key',
  );

  constructor(
    private readonly prisma: PrismaService,
    private readonly graph: GraphService,
  ) {}

  /** Status das contas conectadas (sem expor tokens). */
  async status(userId: string) {
    const accounts = await this.prisma.connectedAccount.findMany({
      where: { userId },
    });
    return accounts.map((a) => ({
      id: a.id,
      platform: a.platform,
      handle: a.handle,
      status: a.status,
      tokenExpiresAt: a.tokenExpiresAt,
    }));
  }

  /** True se o usuário tem ao menos uma conta conectada (qualquer plataforma). */
  async hasConnected(userId: string): Promise<boolean> {
    const count = await this.prisma.connectedAccount.count({
      where: { userId, status: ConnectionStatus.connected },
    });
    return count > 0;
  }

  /** Inicia o OAuth: retorna a URL de consentimento da Meta para o provider. */
  startOAuth(userId: string, provider: MetaProvider) {
    // O state carrega userId + provider para o callback finalizar o fluxo.
    const state = Buffer.from(JSON.stringify({ userId, provider })).toString(
      'base64url',
    );
    return { url: this.graph.buildAuthUrl(provider, state) };
  }

  /** Callback do OAuth: troca code, cifra token e persiste a conta. */
  async handleCallback(provider: MetaProvider, code: string, state: string) {
    let userId: string;
    try {
      const decoded = JSON.parse(
        Buffer.from(state, 'base64url').toString(),
      ) as { userId?: string };
      if (!decoded.userId) throw new Error('sem userId');
      userId = decoded.userId;
    } catch {
      throw new Error('State inválido');
    }

    const identity = await this.graph.exchangeCode(provider, code);
    const tokenExpiresAt = new Date(Date.now() + identity.expiresInSec * 1000);

    // Mapeia o provider escolhido para a coluna `platform`.
    const platform =
      provider === 'facebook' ? Platform.facebook : Platform.instagram;

    const data = {
      handle: `@${identity.username}`,
      igUserId: identity.igUserId,
      accessTokenEnc: encryptSecret(identity.accessToken, this.key),
      tokenExpiresAt,
      status: ConnectionStatus.connected,
    };

    await this.prisma.connectedAccount.upsert({
      where: { userId_platform: { userId, platform } },
      create: { userId, platform, ...data },
      update: data,
    });

    this.logger.log(
      `Conta @${identity.username} conectada via ${provider} (user ${userId})`,
    );
    return { connected: true, handle: `@${identity.username}` };
  }

  /** Desconecta: apaga o token cifrado e marca como desconectado. */
  async disconnect(userId: string, platform: Platform) {
    await this.prisma.connectedAccount.updateMany({
      where: { userId, platform },
      data: {
        accessTokenEnc: null,
        igUserId: null,
        tokenExpiresAt: null,
        status: ConnectionStatus.disconnected,
      },
    });
    return { success: true };
  }

  /** Lista mídias (posts/reels) da conta conectada, para escolher no gatilho. */
  async listMedia(userId: string) {
    const account = await this.prisma.connectedAccount.findFirst({
      where: { userId, status: ConnectionStatus.connected },
      orderBy: { updatedAt: 'desc' },
    });
    if (!account?.igUserId || !account.accessTokenEnc) {
      throw new NotFoundException('Nenhuma conta do Instagram conectada');
    }
    const token = decryptSecret(account.accessTokenEnc, this.key);
    return this.graph.listMedia(account.igUserId, token);
  }
}
