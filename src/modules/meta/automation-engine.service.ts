import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { GraphService } from './graph.service';
import { ContactsService } from '../contacts/contacts.service';
import { decryptSecret, deriveKey } from '../../common/crypto/secrets.crypto';
import {
  ActionType,
  AnalyticsEventType,
  KeywordMatch,
  MessageStatus,
  TriggerType,
} from '@generated/prisma/enums';
import type { Automation, AutomationAction } from '@generated/prisma';

/** Evento normalizado vindo do webhook (comentário ou DM). */
export interface IncomingEvent {
  igUserId: string; // conta que recebeu o evento
  senderId: string; // IGSID de quem interagiu (destinatário da resposta)
  senderUsername?: string;
  text: string;
  kind: 'comment' | 'message' | 'story_reply';
  mediaRef?: string; // id/permalink da mídia para gatilhos "specific"
  commentId?: string; // id do comentário, para responder publicamente
}

type AutomationFull = Automation & {
  trigger: {
    type: TriggerType;
    targetRef: string | null;
    keywordMatch: KeywordMatch;
    keywords: string[];
  } | null;
  actions: AutomationAction[];
};

type MatchResult = { ok: true } | { ok: false; reason: string };

const COMMENT_TRIGGERS: TriggerType[] = [
  TriggerType.reel_comment_specific,
  TriggerType.reel_comment_any,
  TriggerType.post_comment_specific,
  TriggerType.post_comment_any,
];

function normalizeInstagramRef(value: string) {
  return value.trim().replace(/\/$/, '');
}

@Injectable()
export class AutomationEngineService {
  private readonly logger = new Logger(AutomationEngineService.name);
  private readonly key = deriveKey(
    process.env.INTEGRATION_ENC_KEY ?? 'dev-integration-key',
  );

  constructor(
    private readonly prisma: PrismaService,
    private readonly graph: GraphService,
    private readonly contacts: ContactsService,
  ) {}

  /** Ponto de entrada: processa um evento contra as automações do dono da conta. */
  async process(event: IncomingEvent): Promise<void> {
    this.logger.log(
      `Processando evento ${event.kind} para ${event.igUserId}: "${event.text.slice(0, 80)}"`,
    );

    let account = await this.prisma.connectedAccount.findFirst({
      where: { igUserId: event.igUserId, status: 'connected' },
    });
    if (!account) {
      const connectedAccounts = await this.prisma.connectedAccount.findMany({
        where: { status: 'connected' },
        take: 2,
      });
      if (connectedAccounts.length === 1) {
        account = connectedAccounts[0];
        this.logger.warn(
          `Conta ${event.igUserId} não encontrada; usando única conta conectada ${account.igUserId}`,
        );
      }
    }
    if (!account) {
      this.logger.warn(`Conta ${event.igUserId} não conectada; ignorando`);
      return;
    }

    const automations = (await this.prisma.automation.findMany({
      where: { userId: account.userId, status: 'active' },
      include: { trigger: true, actions: { orderBy: { order: 'asc' } } },
    })) as AutomationFull[];

    const token = account.accessTokenEnc
      ? decryptSecret(account.accessTokenEnc, this.key)
      : null;
    await this.repairLegacyMediaTargets(
      automations,
      event,
      account.igUserId!,
      token,
    );

    const evaluations = automations.map((automation) => ({
      automation,
      result: this.matchResult(automation, event),
    }));
    const matched = evaluations
      .filter((item) => item.result.ok)
      .map((item) => item.automation);
    if (!matched.length) {
      this.logger.log(
        `Nenhuma automação casou com ${event.kind}; ativas=${automations.length}`,
      );
      for (const item of evaluations) {
        if (!item.result.ok) {
          this.logger.log(
            `Sem match "${item.automation.name}": ${item.result.reason}`,
          );
        }
      }
      return;
    }
    this.logger.log(
      `${matched.length} automação(ões) casaram: ${matched.map((a) => a.name).join(', ')}`,
    );

    for (const automation of matched) {
      await this.runActions(account.userId, automation, event, {
        igUserId: account.igUserId!,
        accessToken: token,
      });
    }
  }

  /** Casa o gatilho + palavra-chave com o evento. */
  private matches(a: AutomationFull, event: IncomingEvent): boolean {
    return this.matchResult(a, event).ok;
  }

  private matchResult(a: AutomationFull, event: IncomingEvent): MatchResult {
    const trigger = a.trigger;
    if (!trigger) return { ok: false, reason: 'sem trigger' };

    const kindOk =
      (event.kind === 'comment' && COMMENT_TRIGGERS.includes(trigger.type)) ||
      (event.kind === 'story_reply' &&
        trigger.type === TriggerType.story_reply) ||
      (event.kind === 'message' &&
        (trigger.type === TriggerType.dm_new ||
          trigger.type === TriggerType.dm_keyword));
    if (!kindOk) {
      return {
        ok: false,
        reason: `tipo não casa: event=${event.kind}, trigger=${trigger.type}`,
      };
    }

    // Gatilhos "specific" exigem casar a mídia alvo.
    const isSpecific =
      trigger.type === TriggerType.reel_comment_specific ||
      trigger.type === TriggerType.post_comment_specific;
    if (isSpecific && trigger.targetRef) {
      if (!event.mediaRef) {
        return {
          ok: false,
          reason: `mídia específica sem mediaRef no evento; target=${trigger.targetRef}`,
        };
      }

      const targetRef = trigger.targetRef;
      const targetMatchesEvent =
        event.mediaRef.includes(targetRef) ||
        targetRef.includes(event.mediaRef);
      if (!targetMatchesEvent) {
        return {
          ok: false,
          reason: `mídia não casa: event=${event.mediaRef}, target=${targetRef}`,
        };
      }
    }

    // Palavra-chave.
    if (trigger.keywordMatch === KeywordMatch.specific) {
      const haystack = event.text.toUpperCase();
      const matchedKeyword = trigger.keywords.find((k) =>
        haystack.includes(k.toUpperCase()),
      );
      if (!matchedKeyword) {
        return {
          ok: false,
          reason: `palavra-chave não encontrada: keywords=${trigger.keywords.join(', ')}, text="${event.text}"`,
        };
      }
    }
    return { ok: true };
  }

  private async repairLegacyMediaTargets(
    automations: AutomationFull[],
    event: IncomingEvent,
    igUserId: string,
    accessToken: string | null,
  ) {
    if (event.kind !== 'comment' || !event.mediaRef || !accessToken) return;

    const legacyTargets = automations.filter((automation) => {
      const trigger = automation.trigger;
      if (!trigger?.targetRef) return false;
      const isSpecific =
        trigger.type === TriggerType.reel_comment_specific ||
        trigger.type === TriggerType.post_comment_specific;
      return isSpecific && /^https?:\/\//i.test(trigger.targetRef);
    });
    if (!legacyTargets.length) return;

    try {
      const media = await this.graph.listMedia(igUserId, accessToken);
      const eventMedia = media.find((item) => item.id === event.mediaRef);
      if (!eventMedia?.permalink) return;

      const eventPermalink = normalizeInstagramRef(eventMedia.permalink);
      for (const automation of legacyTargets) {
        const target = normalizeInstagramRef(automation.trigger!.targetRef!);
        if (target !== eventPermalink) continue;

        await this.prisma.automationTrigger.update({
          where: { automationId: automation.id },
          data: { targetRef: event.mediaRef },
        });
        automation.trigger!.targetRef = event.mediaRef;
        this.logger.log(
          `Target antigo corrigido em "${automation.name}": ${target} -> ${event.mediaRef}`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `Não foi possível corrigir targetRef legado: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async runActions(
    userId: string,
    automation: AutomationFull,
    event: IncomingEvent,
    account: { igUserId: string; accessToken: string | null },
  ) {
    let contactId: string | undefined;

    // Garante contato sempre que houver username (necessário para registrar mensagens).
    const ensureContact = async () => {
      if (contactId) return contactId;
      const contact = await this.contacts.create(userId, {
        name: event.senderUsername ?? 'Contato',
        username: event.senderUsername ?? event.senderId,
        origin: event.kind,
        keywordUsed: automation.trigger?.keywords[0],
        automationName: automation.name,
      });
      contactId = contact.id;
      await this.logEvent(userId, AnalyticsEventType.lead_created);
      return contactId;
    };

    for (const action of automation.actions) {
      const cfg = (action.config ?? {}) as Record<string, string>;

      switch (action.type) {
        case ActionType.save_contact:
          await ensureContact();
          break;

        case ActionType.add_tag:
          if (cfg.tag) {
            const id = await ensureContact();
            await this.contacts.applyTags(userId, id, [cfg.tag]);
          }
          break;

        case ActionType.send_dm:
        case ActionType.send_link:
        case ActionType.reply_with_button: {
          const id = await ensureContact();
          const parts = [cfg.message, cfg.link].filter(Boolean);
          const text = parts.join('\n') || 'Olá!';
          await this.deliver(userId, automation, id, event, account, text);
          break;
        }

        case ActionType.send_file: {
          const id = await ensureContact();
          const file = cfg.file_id
            ? await this.prisma.file.findFirst({
                where: { id: cfg.file_id, userId },
              })
            : null;
          const text = [cfg.message, file?.url].filter(Boolean).join('\n');
          await this.deliver(
            userId,
            automation,
            id,
            event,
            account,
            text || 'Segue seu material.',
          );
          break;
        }

        case ActionType.reply_comment: {
          // Responde publicamente ao comentário (só faz sentido em gatilhos
          // de comentário, onde há commentId).
          if (!event.commentId || !account.accessToken) break;
          const id = await ensureContact();
          const text =
            cfg.comment_reply || cfg.message || 'Obrigado pelo comentário! 🙌';
          const res = await this.graph.replyToComment({
            commentId: event.commentId,
            accessToken: account.accessToken,
            message: text,
          });
          await this.prisma.message.create({
            data: {
              userId,
              contactId: id,
              automationId: automation.id,
              body: `[resposta ao comentário] ${text}`,
              status: res.ok ? MessageStatus.delivered : MessageStatus.failed,
            },
          });
          if (res.ok)
            await this.logEvent(userId, AnalyticsEventType.message_sent);
          if (!res.ok) {
            this.logger.warn(
              `Falha na resposta pública do comentário ${event.commentId}`,
            );
          }
          break;
        }
      }
    }

    // Contabiliza a execução.
    await this.prisma.automation.update({
      where: { id: automation.id },
      data: { executions: { increment: 1 }, lastRunAt: new Date() },
    });
    await this.logEvent(userId, AnalyticsEventType.comment_captured);
  }

  /** Envia a DM (se houver token) e registra a mensagem. */
  private async deliver(
    userId: string,
    automation: AutomationFull,
    contactId: string,
    event: IncomingEvent,
    account: { igUserId: string; accessToken: string | null },
    text: string,
  ) {
    let status: MessageStatus = MessageStatus.sent;

    if (account.accessToken) {
      if (!event.senderId && !event.commentId) {
        status = MessageStatus.failed;
        this.logger.warn(
          `Evento ${event.kind} sem senderId/commentId; DM não enviada`,
        );
      } else {
        const res = await this.graph.sendDirectMessage({
          igUserId: account.igUserId,
          accessToken: account.accessToken,
          recipientId: event.kind === 'comment' ? undefined : event.senderId,
          commentId: event.kind === 'comment' ? event.commentId : undefined,
          text,
        });
        status = res.ok ? MessageStatus.delivered : MessageStatus.failed;
        if (!res.ok) {
          this.logger.warn(
            `Falha ao enviar DM na automação ${automation.name}: ${res.error ?? 'sem detalhe'}`,
          );
        }
      }
    } else {
      // Sem token (ex.: app Meta ainda não configurado): registra como pendente.
      status = MessageStatus.pending;
    }

    await this.prisma.message.create({
      data: {
        userId,
        contactId,
        automationId: automation.id,
        body: text,
        status,
      },
    });
    if (status !== MessageStatus.failed) {
      await this.logEvent(userId, AnalyticsEventType.message_sent);
    }
  }

  private logEvent(userId: string, type: AnalyticsEventType) {
    return this.prisma.analyticsEvent.create({ data: { userId, type } });
  }
}
