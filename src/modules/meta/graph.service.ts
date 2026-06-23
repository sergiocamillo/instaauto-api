import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

const VERSION = process.env.META_GRAPH_VERSION ?? 'v22.0';
const FB_GRAPH = `https://graph.facebook.com/${VERSION}`;
const IG_GRAPH = `https://graph.instagram.com/${VERSION}`;
const FACEBOOK_OAUTH_HEADERS = { Accept: 'application/json' };

/** Provedor de login escolhido pelo usuário. */
export type MetaProvider = 'instagram' | 'facebook';

export interface MetaIdentity {
  /** ID do Instagram usado nas chamadas (IG user id ou IG business account id). */
  igUserId: string;
  username: string;
  /** Token efetivamente usado para chamadas em nome da conta. */
  accessToken: string;
  expiresInSec: number;
}

export interface MediaItem {
  id: string;
  caption: string | null;
  mediaType: string; // IMAGE | VIDEO | CAROUSEL_ALBUM
  /** REELS para vídeos curtos; usamos o product type quando disponível. */
  mediaProductType: string | null;
  thumbnailUrl: string | null;
  permalink: string | null;
  timestamp: string | null;
}

function graphBaseForToken(accessToken: string) {
  return accessToken.startsWith('IG') ? IG_GRAPH : FB_GRAPH;
}

/**
 * Cliente da Meta Graph API. Todas as chamadas são server-side.
 *
 * Suporta os dois fluxos do META_API_USAGE.md:
 *  - Instagram Login (Creator/Business sem Página)
 *  - Facebook Login (Business com Página vinculada)
 */
@Injectable()
export class GraphService {
  private readonly logger = new Logger(GraphService.name);

  // Credenciais do app Meta (usadas no fluxo Facebook Login).
  private get appId() {
    return process.env.META_APP_ID ?? '';
  }
  private get appSecret() {
    return process.env.META_APP_SECRET ?? '';
  }

  // O fluxo Instagram Login exige o "Instagram App ID/Secret" próprios
  // (Instagram → API setup with Instagram login → Business login settings),
  // que são DIFERENTES do Meta App ID. Faz fallback para os do Meta se ausentes.
  private get instagramAppId() {
    return process.env.META_INSTAGRAM_APP_ID ?? this.appId;
  }
  private get instagramAppSecret() {
    return process.env.META_INSTAGRAM_APP_SECRET ?? this.appSecret;
  }
  /** Redirect URI usado na autorização e na troca do code. */
  private redirectUri() {
    const base = (
      process.env.META_OAUTH_REDIRECT_URI ??
      'http://localhost:3001/api/accounts/callback'
    ).replace(/\/$/, '');
    const [url, query] = base.split('?');
    if (!query) return url;

    // Compatibilidade: se o env antigo tinha ?provider=..., remove daqui.
    // O provider agora vem no OAuth state, evitando mismatch por query string.
    const params = new URLSearchParams(query);
    params.delete('provider');
    const normalizedQuery = params.toString();
    return normalizedQuery ? `${url}?${normalizedQuery}` : url;
  }

  /* --------------------------- Auth URLs ---------------------------- */

  buildAuthUrl(provider: MetaProvider, state: string): string {
    return provider === 'facebook'
      ? this.buildFacebookAuthUrl(state)
      : this.buildInstagramAuthUrl(state);
  }

  private buildInstagramAuthUrl(state: string): string {
    const scope = [
      'instagram_business_basic',
      'instagram_business_manage_messages',
      'instagram_business_manage_comments',
    ].join(',');
    const params = new URLSearchParams({
      client_id: this.instagramAppId,
      redirect_uri: this.redirectUri(),
      scope,
      response_type: 'code',
      state,
    });
    return `https://www.instagram.com/oauth/authorize?${params.toString()}`;
  }

  private buildFacebookAuthUrl(state: string): string {
    // Escopos mínimos para ler o IG business account vinculado à Página e
    // gerenciar comentários/DMs. pages_manage_metadata NÃO é usado (webhooks
    // são assinados pelo painel da Meta) e quebra o login se não aprovado.
    const scope = [
      'instagram_basic',
      'instagram_manage_comments',
      'instagram_manage_messages',
      'pages_show_list',
      'pages_read_engagement',
      // Ajuda /me/accounts a retornar o instagram_business_account vinculado.
      'business_management',
    ].join(',');
    const params = new URLSearchParams({
      client_id: this.appId,
      redirect_uri: this.redirectUri(),
      scope,
      response_type: 'code',
      state,
    });
    return `https://www.facebook.com/${VERSION}/dialog/oauth?${params.toString()}`;
  }

  /* ------------------------- Code exchange -------------------------- */

  async exchangeCode(
    provider: MetaProvider,
    code: string,
  ): Promise<MetaIdentity> {
    try {
      return provider === 'facebook'
        ? await this.exchangeFacebook(code)
        : await this.exchangeInstagram(code);
    } catch (err) {
      // Expõe o corpo de erro da Meta (motivo real) na mensagem lançada.
      if (axios.isAxiosError(err)) {
        const body = this.formatAxiosError(err);
        throw new Error(`Meta API (${provider}): ${body}`);
      }
      throw err;
    }
  }

  private formatAxiosError(err: unknown): string {
    if (!axios.isAxiosError(err)) return String(err);

    const status = err.response?.status;
    const contentType = err.response?.headers['content-type'];
    const data = err.response?.data;
    if (typeof data === 'string') {
      const title = data.match(/<title>(.*?)<\/title>/i)?.[1];
      const heading = data.match(/<h1[^>]*>(.*?)<\/h1>/i)?.[1];
      const clean = (title ?? heading ?? data)
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 300);
      return JSON.stringify({ status, contentType, message: clean });
    }

    return JSON.stringify(data ?? err.message);
  }

  /** Instagram Login: short → long-lived token, depois identidade. */
  private async exchangeInstagram(code: string): Promise<MetaIdentity> {
    const tokenRes = await axios.post<{ access_token: string }>(
      'https://api.instagram.com/oauth/access_token',
      new URLSearchParams({
        client_id: this.instagramAppId,
        client_secret: this.instagramAppSecret,
        grant_type: 'authorization_code',
        redirect_uri: this.redirectUri(),
        code,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
    );

    const longRes = await axios.get<{
      access_token: string;
      expires_in?: number;
    }>(`${IG_GRAPH}/access_token`, {
      params: {
        grant_type: 'ig_exchange_token',
        client_secret: this.instagramAppSecret,
        access_token: tokenRes.data.access_token,
      },
    });
    const accessToken = longRes.data.access_token;

    const meRes = await axios.get<{ id: string; username: string }>(
      `${IG_GRAPH}/me`,
      { params: { fields: 'id,username', access_token: accessToken } },
    );

    return {
      igUserId: meRes.data.id,
      username: meRes.data.username,
      accessToken,
      expiresInSec: longRes.data.expires_in ?? 60 * 24 * 3600,
    };
  }

  /**
   * Facebook Login: short → long-lived user token, lista Páginas, pega o
   * Instagram Business Account vinculado e usa o PAGE access token.
   */
  private async exchangeFacebook(code: string): Promise<MetaIdentity> {
    // 1) code -> short-lived user token
    const shortRes = await axios.get<{ access_token: string }>(
      `${FB_GRAPH}/oauth/access_token`,
      {
        params: {
          client_id: this.appId,
          client_secret: this.appSecret,
          redirect_uri: this.redirectUri(),
          code,
        },
        headers: FACEBOOK_OAUTH_HEADERS,
      },
    );

    // 2) -> long-lived user token
    const longRes = await axios.get<{
      access_token: string;
      expires_in?: number;
    }>(`${FB_GRAPH}/oauth/access_token`, {
      params: {
        grant_type: 'fb_exchange_token',
        client_id: this.appId,
        client_secret: this.appSecret,
        fb_exchange_token: shortRes.data.access_token,
      },
      headers: FACEBOOK_OAUTH_HEADERS,
    });
    const userToken = longRes.data.access_token;

    // 3) Páginas + IG business account vinculado + page access token
    interface FbPage {
      id: string;
      name: string;
      access_token: string;
      instagram_business_account?: { id: string };
    }
    const pagesRes = await axios.get<{ data: FbPage[] }>(
      `${FB_GRAPH}/me/accounts`,
      {
        params: {
          fields: 'id,name,access_token,instagram_business_account',
          access_token: userToken,
        },
      },
    );

    const pages = pagesRes.data.data ?? [];
    this.logger.log(
      `Facebook: ${pages.length} página(s) — ${pages
        .map((p) => `${p.name}:${p.instagram_business_account?.id ?? 'sem-ig'}`)
        .join(', ')}`,
    );

    if (pages.length === 0) {
      throw new Error(
        'Nenhuma Página do Facebook foi concedida. No consentimento, marque a Página e habilite a permissão de Páginas.',
      );
    }

    // Tenta achar a Página com IG já no payload; senão consulta cada Página
    // individualmente (em alguns casos o campo não vem em /me/accounts).
    let page = pages.find((p) => p.instagram_business_account);
    if (!page) {
      for (const p of pages) {
        try {
          const detail = await axios.get<{
            instagram_business_account?: { id: string };
          }>(`${FB_GRAPH}/${p.id}`, {
            params: {
              fields: 'instagram_business_account',
              access_token: p.access_token,
            },
          });
          if (detail.data.instagram_business_account) {
            page = {
              ...p,
              instagram_business_account:
                detail.data.instagram_business_account,
            };
            break;
          }
        } catch {
          /* ignora e tenta a próxima */
        }
      }
    }

    if (!page?.instagram_business_account) {
      throw new Error(
        `Página(s) encontrada(s) mas sem Instagram Business vinculado: ${pages
          .map((p) => p.name)
          .join(
            ', ',
          )}. Vincule sua conta do Instagram (Profissional) à Página no app do Instagram → Configurações → Página, e tente de novo.`,
      );
    }
    const igUserId = page.instagram_business_account.id;
    const pageToken = page.access_token;

    // 4) handle do Instagram
    const igRes = await axios.get<{ username: string }>(
      `${FB_GRAPH}/${igUserId}`,
      { params: { fields: 'username', access_token: pageToken } },
    );

    return {
      igUserId,
      username: igRes.data.username,
      // Page token é de longa duração quando derivado de long-lived user token.
      accessToken: pageToken,
      expiresInSec: longRes.data.expires_in ?? 60 * 24 * 3600,
    };
  }

  /* ----------------------------- Media ------------------------------ */

  /** Lista mídias da conta (feed). Stories exigem endpoint separado. */
  async listMedia(igUserId: string, accessToken: string): Promise<MediaItem[]> {
    const base = accessToken.startsWith('IG') ? IG_GRAPH : FB_GRAPH;
    const res = await axios.get<{
      data: Array<{
        id: string;
        caption?: string;
        media_type?: string;
        media_product_type?: string;
        thumbnail_url?: string;
        media_url?: string;
        permalink?: string;
        timestamp?: string;
      }>;
    }>(`${base}/${igUserId}/media`, {
      params: {
        fields:
          'id,caption,media_type,media_product_type,thumbnail_url,media_url,permalink,timestamp',
        limit: 50,
        access_token: accessToken,
      },
    });

    return res.data.data.map((m) => ({
      id: m.id,
      caption: m.caption ?? null,
      mediaType: m.media_type ?? 'IMAGE',
      mediaProductType: m.media_product_type ?? null,
      thumbnailUrl: m.thumbnail_url ?? m.media_url ?? null,
      permalink: m.permalink ?? null,
      timestamp: m.timestamp ?? null,
    }));
  }

  /* --------------------------- Messaging ---------------------------- */

  async sendDirectMessage(params: {
    igUserId: string;
    accessToken: string;
    recipientId?: string;
    commentId?: string;
    text: string;
  }): Promise<{ ok: boolean; error?: string }> {
    try {
      const recipient = params.commentId
        ? { comment_id: params.commentId }
        : { id: params.recipientId };

      await axios.post(
        `${graphBaseForToken(params.accessToken)}/${params.igUserId}/messages`,
        {
          recipient,
          message: { text: params.text },
        },
        { params: { access_token: params.accessToken } },
      );
      return { ok: true };
    } catch (err) {
      const message = axios.isAxiosError(err)
        ? JSON.stringify(err.response?.data ?? err.message)
        : String(err);
      this.logger.error(`Falha ao enviar DM: ${message}`);
      return { ok: false, error: message };
    }
  }

  /** Responde publicamente a um comentário (POST /{comment-id}/replies). */
  async replyToComment(params: {
    commentId: string;
    accessToken: string;
    message: string;
  }): Promise<{ ok: boolean; error?: string }> {
    try {
      await axios.post(
        `${graphBaseForToken(params.accessToken)}/${params.commentId}/replies`,
        { message: params.message },
        { params: { access_token: params.accessToken } },
      );
      return { ok: true };
    } catch (err) {
      const message = axios.isAxiosError(err)
        ? JSON.stringify(err.response?.data ?? err.message)
        : String(err);
      this.logger.error(`Falha ao responder comentário: ${message}`);
      return { ok: false, error: message };
    }
  }
}
