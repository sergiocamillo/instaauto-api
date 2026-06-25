import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Header,
  Headers,
  Logger,
  Post,
  Query,
  Req,
  type RawBodyRequest,
} from '@nestjs/common';
import type { Request } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { ApiExcludeController } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import {
  AutomationEngineService,
  type IncomingEvent,
} from './automation-engine.service';

@ApiExcludeController()
@Public()
@Controller('webhooks/meta')
export class WebhookController {
  private readonly logger = new Logger(WebhookController.name);

  constructor(private readonly engine: AutomationEngineService) {}

  /** Verificação do webhook (handshake hub.challenge). */
  @Get()
  @Header('Content-Type', 'text/plain')
  verify(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
  ): string {
    const expected = process.env.META_WEBHOOK_VERIFY_TOKEN;
    if (mode === 'subscribe' && token === expected) {
      return challenge;
    }
    throw new ForbiddenException('Verificação falhou');
  }

  /** Recebe eventos. Responde 200 rápido e processa de forma síncrona. */
  @Post()
  async receive(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-hub-signature-256') signature: string,
  ) {
    this.assertSignature(req.rawBody, signature);

    const body = req.body as MetaWebhookBody;
    // Loga o payload bruto — essencial para depurar o que a Meta envia
    // (estrutura varia entre Instagram Login e Facebook Page).
    this.logger.log(`Webhook recebido: ${JSON.stringify(body)}`);
    const events = this.parse(body);
    this.logger.log(`Eventos normalizados: ${events.length}`);

    // Processa cada evento; erros são logados sem derrubar a resposta.
    for (const event of events) {
      try {
        await this.engine.process(event);
      } catch (err) {
        this.logger.error(
          `Erro ao processar evento: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return { received: true };
  }

  /** Valida X-Hub-Signature-256 com os app secrets configurados. */
  private assertSignature(rawBody: Buffer | undefined, signature?: string) {
    const secrets = [
      process.env.META_APP_SECRET,
      process.env.META_INSTAGRAM_APP_SECRET,
    ].filter((secret, index, arr): secret is string =>
      Boolean(secret && arr.indexOf(secret) === index),
    );
    if (!secrets.length) return; // app ainda não configurado: pula validação em dev
    if (!rawBody || !signature) {
      this.logger.warn(
        `Webhook sem assinatura verificável: rawBody=${rawBody ? rawBody.length : 0}, signature=${signature ? 'presente' : 'ausente'}`,
      );
      throw new BadRequestException('Assinatura ausente');
    }

    const b = Buffer.from(signature);
    for (const secret of secrets) {
      const expected =
        'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
      const a = Buffer.from(expected);
      if (a.length === b.length && timingSafeEqual(a, b)) return;
    }

    this.logger.warn(
      `Assinatura inválida no webhook: rawBody=${rawBody.length}, signature=${signature.slice(0, 16)}..., secrets=${secrets.length}`,
    );
    throw new ForbiddenException('Assinatura inválida');
  }

  /** Normaliza o payload da Meta em eventos internos. */
  private parse(body: MetaWebhookBody): IncomingEvent[] {
    const events: IncomingEvent[] = [];
    for (const entry of body.entry ?? []) {
      const igUserId = entry.id;

      // Comentários (campos "comments" e "live_comments").
      for (const change of entry.changes ?? []) {
        if (
          (change.field === 'comments' || change.field === 'live_comments') &&
          change.value
        ) {
          events.push({
            igUserId,
            senderId: change.value.from?.id ?? '',
            senderUsername: change.value.from?.username,
            text: change.value.text ?? '',
            kind: 'comment',
            eventId: change.value.id,
            mediaRef: change.value.media?.id ?? change.value.media?.permalink,
            mediaProductType: change.value.media?.media_product_type,
            commentId: change.value.id,
          });
        }
      }

      // Mensagens diretas e respostas de Story (campo "messaging").
      for (const msg of entry.messaging ?? []) {
        const message = msg.message;
        const quickReplyPayload = message?.quick_reply?.payload;
        const text = message?.text ?? quickReplyPayload;
        if (text) {
          events.push({
            igUserId: msg.recipient?.id ?? igUserId,
            senderId: msg.sender?.id ?? '',
            text,
            kind: message?.reply_to?.story ? 'story_reply' : 'message',
            eventId: message?.mid,
            quickReplyPayload,
          });
        }
      }
    }
    return events;
  }
}

// Tipos parciais do payload da Meta.
interface MetaWebhookBody {
  entry?: Array<{
    id: string;
    changes?: Array<{
      field: string;
      value?: {
        id?: string;
        text?: string;
        from?: { id?: string; username?: string };
        media?: {
          id?: string;
          permalink?: string;
          media_product_type?: string;
        };
      };
    }>;
    messaging?: Array<{
      sender?: { id?: string };
      recipient?: { id?: string };
      message?: {
        mid?: string;
        text?: string;
        quick_reply?: { payload?: string };
        reply_to?: { story?: unknown };
      };
    }>;
  }>;
}
