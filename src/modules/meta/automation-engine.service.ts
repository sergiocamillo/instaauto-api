import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { GraphService } from './graph.service';
import type { QuickReply } from './graph.service';
import { ContactsService } from '../contacts/contacts.service';
import { decryptSecret, deriveKey } from '../../common/crypto/secrets.crypto';
import {
  ActionType,
  AnalyticsEventType,
  KeywordMatch,
  MessageStatus,
  Platform,
  TriggerType,
} from '@generated/prisma/enums';
import type {
  Automation,
  AutomationAction,
  ConnectedAccount,
  Prisma,
} from '@generated/prisma';

/** Evento normalizado vindo do webhook (comentário ou DM). */
export interface IncomingEvent {
  igUserId: string; // conta que recebeu o evento
  senderId: string; // IGSID de quem interagiu (destinatário da resposta)
  senderUsername?: string;
  text: string;
  kind: 'comment' | 'message' | 'story_reply';
  eventId?: string;
  quickReplyPayload?: string;
  mediaRef?: string; // id/permalink da mídia para gatilhos "specific"
  mediaProductType?: string;
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

interface MessageStep {
  message: string;
  delayMinutes: number;
  waitForReply: boolean;
}

interface PendingReplyStep {
  userId: string;
  automation: AutomationFull;
  contactId: string;
  igUserId: string;
  accessToken: string | null;
  text: string;
  sourceKey: string;
}

interface PendingFollowDelivery {
  userId: string;
  automation: AutomationFull;
  actionId: string;
  contactId: string;
  event: IncomingEvent;
  account: { igUserId: string; accessToken: string | null };
  config: Record<string, unknown>;
  fallback: string;
  sourceKey: string;
}

const COMMENT_TRIGGERS: TriggerType[] = [
  TriggerType.reel_comment_specific,
  TriggerType.reel_comment_any,
  TriggerType.post_comment_specific,
  TriggerType.post_comment_any,
];

function normalizeInstagramRef(value: string) {
  return value.trim().replace(/\/$/, '');
}

function preferredAccount(accounts: ConnectedAccount[]) {
  return (
    accounts.find((account) => account.platform === Platform.facebook) ??
    accounts[0] ??
    null
  );
}

function sourceKey(parts: Array<string | number | null | undefined>) {
  return parts
    .map((part) =>
      String(part ?? 'none')
        .replace(/\s+/g, ' ')
        .slice(0, 160),
    )
    .join(':');
}

function stableIndex(seed: string, length: number) {
  if (length <= 1) return 0;
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return hash % length;
}

@Injectable()
export class AutomationEngineService {
  private readonly logger = new Logger(AutomationEngineService.name);
  private readonly pendingReplySteps = new Map<string, PendingReplyStep[]>();
  private readonly pendingFollowDeliveries = new Map<
    string,
    PendingFollowDelivery[]
  >();
  private readonly scheduledSourceKeys = new Set<string>();
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

    const matchingAccounts = await this.prisma.connectedAccount.findMany({
      where: { igUserId: event.igUserId, status: 'connected' },
    });
    let account = preferredAccount(matchingAccounts);
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
    this.logger.log(
      `Conta escolhida: platform=${account.platform}, igUserId=${account.igUserId}, token=${token?.startsWith('IG') ? 'instagram' : token ? 'graph' : 'none'}`,
    );
    await this.repairLegacyMediaTargets(
      automations,
      event,
      account.igUserId!,
      token,
    );
    if (event.kind === 'message' || event.kind === 'story_reply') {
      const handledFollowCheck = await this.flushPendingFollowDeliveries(
        account.userId,
        event,
        {
          igUserId: account.igUserId!,
          accessToken: token,
        },
      );
      const handledPendingReply = await this.flushPendingReplySteps(
        account.userId,
        event,
        {
          igUserId: account.igUserId!,
          accessToken: token,
        },
      );
      if (
        handledPendingReply &&
        event.quickReplyPayload?.startsWith('BUTTON:')
      ) {
        return;
      }
      if (
        handledFollowCheck &&
        event.quickReplyPayload?.startsWith('FOLLOW_CHECK:')
      ) {
        return;
      }
    }

    const evaluations = automations.map((automation) => ({
      automation,
      result: this.matchResult(automation, event),
    }));
    const matched = evaluations
      .filter((item) => item.result.ok)
      .map((item) => item.automation);
    if (!matched.length) {
      this.logger.log(
        `Nenhuma automação casou com ${event.kind}; ativas=${automations.length}; media=${event.mediaRef ?? 'n/a'}; product=${event.mediaProductType ?? 'n/a'}`,
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
      this.logger.log(
        `Ações de "${automation.name}": ${automation.actions.map((a) => a.type).join(', ') || 'nenhuma'}`,
      );
    }

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
          reason: `mídia não casa: event=${event.mediaRef}, product=${event.mediaProductType ?? 'n/a'}, target=${targetRef}`,
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

  private matchedKeyword(automation: AutomationFull, event: IncomingEvent) {
    const keywords = automation.trigger?.keywords ?? [];
    const haystack = event.text.toUpperCase();
    return keywords.find((k) => haystack.includes(k.toUpperCase())) ?? '';
  }

  private renderTemplate(
    template: string,
    event: IncomingEvent,
    automation: AutomationFull,
  ) {
    const username = event.senderUsername ?? '';
    const firstName = username.split(/[._\-\s]/)[0] || username;
    const vars: Record<string, string> = {
      nome: username || 'Contato',
      name: username || 'Contato',
      primeiro_nome: firstName || 'Contato',
      first_name: firstName || 'Contato',
      username,
      arroba: username ? `@${username}` : '',
      comentario: event.text,
      comment: event.text,
      mensagem: event.text,
      message: event.text,
      keyword: this.matchedKeyword(automation, event),
      media_id: event.mediaRef ?? '',
    };

    return template.replace(/\{\{\s*([\w_]+)\s*\}\}/g, (_match, key) => {
      return vars[String(key).toLowerCase()] ?? '';
    });
  }

  private pickVariant(values: unknown, fallback: string, seed: string) {
    const variants = Array.isArray(values)
      ? values.map((v) => String(v).trim()).filter(Boolean)
      : [];
    if (!variants.length) return fallback;
    return variants[stableIndex(seed, variants.length)];
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
      const cfg = (action.config ?? {}) as Record<string, unknown>;
      this.logger.log(`Executando ação ${action.type} em "${automation.name}"`);

      switch (action.type) {
        case ActionType.save_contact:
          await ensureContact();
          break;

        case ActionType.add_tag:
          if (cfg.tag) {
            const id = await ensureContact();
            await this.contacts.applyTags(userId, id, [String(cfg.tag)]);
          }
          break;

        case ActionType.send_dm:
        case ActionType.send_link: {
          const id = await ensureContact();
          await this.runGatedMessageSteps({
            userId,
            automation,
            actionId: action.id,
            contactId: id,
            event,
            account,
            config: cfg,
            fallback: 'Olá!',
          });
          break;
        }

        case ActionType.reply_with_button: {
          const id = await ensureContact();
          await this.runButtonAction({
            userId,
            automation,
            actionId: action.id,
            contactId: id,
            event,
            account,
            config: cfg,
          });
          break;
        }

        case ActionType.send_file: {
          const id = await ensureContact();
          const file = cfg.file_id
            ? await this.prisma.file.findFirst({
                where: { id: String(cfg.file_id), userId },
              })
            : null;
          await this.runGatedMessageSteps({
            userId,
            automation,
            actionId: action.id,
            event,
            account,
            contactId: id,
            config: { ...cfg, link: file?.url ?? cfg.link },
            fallback: 'Segue seu material.',
          });
          break;
        }

        case ActionType.reply_comment: {
          // Responde publicamente ao comentário (só faz sentido em gatilhos
          // de comentário, onde há commentId).
          if (!event.commentId || !account.accessToken) break;
          const id = await ensureContact();
          const pickedReply = this.pickVariant(
            cfg.comment_replies,
            String(
              cfg.comment_reply ||
                cfg.message ||
                'Obrigado pelo comentário! 🙌',
            ),
            sourceKey([
              event.eventId ?? event.commentId,
              automation.id,
              action.id,
            ]),
          );
          const text = this.renderTemplate(pickedReply, event, automation);
          const replySourceKey = sourceKey([
            'reply_comment',
            event.eventId ?? event.commentId,
            automation.id,
            action.id,
          ]);
          if (await this.messageExists(replySourceKey)) {
            this.logger.log(
              `Resposta pública duplicada ignorada: ${replySourceKey}`,
            );
            break;
          }
          const messageId = await this.reserveMessage({
            userId,
            contactId: id,
            automationId: automation.id,
            sourceKey: replySourceKey,
            body: `[resposta ao comentário] ${text}`,
            status: MessageStatus.pending,
          });
          if (!messageId) break;
          const res = await this.graph.replyToComment({
            commentId: event.commentId,
            accessToken: account.accessToken,
            message: text,
          });
          await this.prisma.message.update({
            where: { id: messageId },
            data: {
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

  private parseMessageSteps(config: Record<string, unknown>): MessageStep[] {
    const rawSteps = Array.isArray(config.steps) ? config.steps : [];
    const steps = rawSteps
      .map((raw) => {
        if (!raw || typeof raw !== 'object') return null;
        const item = raw as Record<string, unknown>;
        const message = String(item.message ?? '').trim();
        if (!message) return null;
        return {
          message,
          delayMinutes: Math.max(
            0,
            Number(item.delay_minutes ?? item.delayMinutes ?? 0) || 0,
          ),
          waitForReply: Boolean(item.wait_for_reply ?? item.waitForReply),
        };
      })
      .filter((step): step is MessageStep => Boolean(step));

    if (steps.length > 0) return steps;

    const fallbackMessage = String(config.message ?? '').trim();
    return fallbackMessage
      ? [{ message: fallbackMessage, delayMinutes: 0, waitForReply: false }]
      : [];
  }

  private async runMessageSteps(params: {
    userId: string;
    automation: AutomationFull;
    actionId: string;
    contactId: string;
    event: IncomingEvent;
    account: { igUserId: string; accessToken: string | null };
    config: Record<string, unknown>;
    fallback: string;
  }) {
    const steps = this.parseMessageSteps(params.config);
    const link = String(params.config.link ?? '').trim();
    const effectiveSteps =
      steps.length > 0
        ? steps
        : [{ message: params.fallback, delayMinutes: 0, waitForReply: false }];

    for (const [index, step] of effectiveSteps.entries()) {
      const text = [step.message, index === 0 ? link : '']
        .filter(Boolean)
        .join('\n');
      const renderedText = this.renderTemplate(
        text,
        params.event,
        params.automation,
      );
      const stepSourceKey = sourceKey([
        'dm',
        params.event.eventId ??
          params.event.commentId ??
          `${params.event.kind}:${params.event.senderId}:${params.event.text}`,
        params.automation.id,
        params.actionId,
        index,
        renderedText,
      ]);

      if (step.waitForReply) {
        this.queuePendingReplyStep({
          userId: params.userId,
          automation: params.automation,
          contactId: params.contactId,
          igUserId: params.account.igUserId,
          accessToken: params.account.accessToken,
          senderId: params.event.senderId,
          text: renderedText,
          sourceKey: stepSourceKey,
        });
        continue;
      }

      if (step.delayMinutes > 0) {
        this.scheduleDelayedStep({
          ...params,
          text: renderedText,
          sourceKey: stepSourceKey,
          delayMinutes: step.delayMinutes,
        });
        continue;
      }

      await this.deliver(
        params.userId,
        params.automation,
        params.contactId,
        params.event,
        params.account,
        renderedText,
        stepSourceKey,
      );
    }
  }

  private async runGatedMessageSteps(params: {
    userId: string;
    automation: AutomationFull;
    actionId: string;
    contactId: string;
    event: IncomingEvent;
    account: { igUserId: string; accessToken: string | null };
    config: Record<string, unknown>;
    fallback: string;
  }) {
    if (
      !(await this.ensureFollowerBeforeDelivery({
        ...params,
        sourceKey: sourceKey([
          'follow_gate',
          params.event.eventId ??
            params.event.commentId ??
            `${params.event.kind}:${params.event.senderId}:${params.event.text}`,
          params.automation.id,
          params.actionId,
        ]),
      }))
    ) {
      return;
    }

    await this.runMessageSteps(params);
  }

  private async runButtonAction(params: {
    userId: string;
    automation: AutomationFull;
    actionId: string;
    contactId: string;
    event: IncomingEvent;
    account: { igUserId: string; accessToken: string | null };
    config: Record<string, unknown>;
  }) {
    const steps = this.parseMessageSteps(params.config);
    const firstStep = steps[0]?.message || String(params.config.message ?? '');
    const buttonText = this.renderTemplate(
      firstStep || 'Clique no botão abaixo para continuar.',
      params.event,
      params.automation,
    );
    const buttonLabel = String(params.config.button_label || 'Continuar')
      .trim()
      .slice(0, 20);
    const link = String(params.config.link ?? '').trim();
    const followup = [
      String(params.config.button_followup ?? '').trim(),
      link,
    ]
      .filter(Boolean)
      .join('\n');
    const seed =
      params.event.eventId ??
      params.event.commentId ??
      `${params.event.kind}:${params.event.senderId}:${params.event.text}`;
    const buttonSourceKey = sourceKey([
      'button_prompt',
      seed,
      params.automation.id,
      params.actionId,
    ]);

    await this.deliver(
      params.userId,
      params.automation,
      params.contactId,
      params.event,
      params.account,
      buttonText,
      buttonSourceKey,
      [
        {
          title: buttonLabel || 'Continuar',
          payload: sourceKey(['BUTTON', params.automation.id, params.actionId]),
        },
      ],
    );

    if (!followup) return;
    this.queuePendingReplyStep({
      userId: params.userId,
      automation: params.automation,
      contactId: params.contactId,
      igUserId: params.account.igUserId,
      accessToken: params.account.accessToken,
      senderId: params.event.senderId,
      text: this.renderTemplate(followup, params.event, params.automation),
      sourceKey: sourceKey([
        'button_followup',
        seed,
        params.automation.id,
        params.actionId,
        followup,
      ]),
    });
  }

  private requiresFollow(config: Record<string, unknown>) {
    return Boolean(config.require_follow ?? config.requireFollow);
  }

  private async ensureFollowerBeforeDelivery(params: PendingFollowDelivery) {
    if (!this.requiresFollow(params.config)) return true;
    const status = await this.getFollowStatus(params);
    if (status === 'following') return true;

    this.queuePendingFollowDelivery(params);
    await this.sendFollowPrompt(params, status);
    return false;
  }

  private async getFollowStatus(params: {
    event: IncomingEvent;
    account: { accessToken: string | null };
  }): Promise<'following' | 'not_following' | 'unknown'> {
    if (!params.account.accessToken || !params.event.senderId) return 'unknown';
    const profile = await this.graph.getUserProfile({
      userId: params.event.senderId,
      accessToken: params.account.accessToken,
    });
    if (profile?.isUserFollowBusiness === true) return 'following';
    if (profile?.isUserFollowBusiness === false) return 'not_following';
    return 'unknown';
  }

  private queuePendingFollowDelivery(params: PendingFollowDelivery) {
    const key = this.pendingKey(params.userId, params.event.senderId);
    const current = this.pendingFollowDeliveries.get(key) ?? [];
    if (current.some((item) => item.sourceKey === params.sourceKey)) {
      return;
    }
    this.pendingFollowDeliveries.set(key, [...current, params]);
    this.logger.log(
      `Entrega aguardando follow em "${params.automation.name}" para ${params.event.senderId}`,
    );
  }

  private async sendFollowPrompt(
    params: PendingFollowDelivery,
    status: 'not_following' | 'unknown',
  ) {
    const fallback =
      status === 'unknown'
        ? 'Para liberar o conteúdo, siga o perfil e toque no botão abaixo.'
        : 'Antes de enviar o conteúdo, siga o perfil e toque no botão abaixo.';
    const text = this.renderTemplate(
      String(params.config.follow_prompt || fallback),
      params.event,
      params.automation,
    );
    const buttonLabel = String(
      params.config.follow_button_label || 'Já estou seguindo',
    )
      .trim()
      .slice(0, 20);
    await this.deliver(
      params.userId,
      params.automation,
      params.contactId,
      params.event,
      params.account,
      text,
      sourceKey([
        params.sourceKey,
        'prompt',
        status,
        params.event.eventId ?? params.event.text,
      ]),
      [
        {
          title: buttonLabel || 'Já estou seguindo',
          payload: sourceKey([
            'FOLLOW_CHECK',
            params.automation.id,
            params.actionId,
          ]),
        },
      ],
    );
  }

  private async flushPendingFollowDeliveries(
    userId: string,
    event: IncomingEvent,
    account: { igUserId: string; accessToken: string | null },
  ) {
    if (!event.senderId) return false;
    const key = this.pendingKey(userId, event.senderId);
    const pending = this.pendingFollowDeliveries.get(key);
    if (!pending?.length) return false;

    this.pendingFollowDeliveries.delete(key);
    this.logger.log(
      `Revalidando follow para ${pending.length} entrega(s) de ${event.senderId}`,
    );

    const stillPending: PendingFollowDelivery[] = [];
    for (const delivery of pending) {
      const nextDelivery = {
        ...delivery,
        event,
        account: {
          igUserId: account.igUserId,
          accessToken: account.accessToken,
        },
      };
      const status = await this.getFollowStatus(nextDelivery);
      if (status === 'following') {
        await this.runMessageSteps({
          ...nextDelivery,
          config: { ...nextDelivery.config, require_follow: false },
        });
      } else {
        stillPending.push(delivery);
        await this.sendFollowPrompt(nextDelivery, status);
      }
    }

    if (stillPending.length) {
      this.pendingFollowDeliveries.set(key, stillPending);
    }
    return true;
  }

  private pendingKey(userId: string, senderId: string) {
    return `${userId}:${senderId}`;
  }

  private queuePendingReplyStep(
    params: PendingReplyStep & { senderId: string },
  ) {
    const key = this.pendingKey(params.userId, params.senderId);
    const current = this.pendingReplySteps.get(key) ?? [];
    if (current.some((step) => step.sourceKey === params.sourceKey)) {
      this.logger.log(`Etapa pendente duplicada ignorada: ${params.sourceKey}`);
      return;
    }
    this.pendingReplySteps.set(key, [...current, params]);
    this.logger.log(
      `Etapa aguardando próxima resposta em "${params.automation.name}" para ${params.senderId}`,
    );
  }

  private async flushPendingReplySteps(
    userId: string,
    event: IncomingEvent,
    account: { igUserId: string; accessToken: string | null },
  ) {
    if (!event.senderId) return false;
    const key = this.pendingKey(userId, event.senderId);
    const pending = this.pendingReplySteps.get(key);
    if (!pending?.length) return false;

    this.pendingReplySteps.delete(key);
    this.logger.log(
      `Disparando ${pending.length} etapa(s) após resposta de ${event.senderId}`,
    );
    for (const step of pending) {
      await this.deliver(
        step.userId,
        step.automation,
        step.contactId,
        event,
        {
          igUserId: account.igUserId,
          accessToken: account.accessToken,
        },
        step.text,
        step.sourceKey,
      );
    }
    return true;
  }

  private scheduleDelayedStep(params: {
    userId: string;
    automation: AutomationFull;
    contactId: string;
    event: IncomingEvent;
    account: { igUserId: string; accessToken: string | null };
    text: string;
    sourceKey: string;
    delayMinutes: number;
  }) {
    if (this.scheduledSourceKeys.has(params.sourceKey)) {
      this.logger.log(`Agendamento duplicado ignorado: ${params.sourceKey}`);
      return;
    }
    this.scheduledSourceKeys.add(params.sourceKey);
    const delayMs = params.delayMinutes * 60_000;
    this.logger.log(
      `Agendando ação em "${params.automation.name}" para ${params.delayMinutes} minuto(s)`,
    );
    setTimeout(() => {
      void this.deliver(
        params.userId,
        params.automation,
        params.contactId,
        params.event,
        params.account,
        params.text,
        params.sourceKey,
      );
      this.scheduledSourceKeys.delete(params.sourceKey);
    }, delayMs);
  }

  /** Envia a DM (se houver token) e registra a mensagem. */
  private async deliver(
    userId: string,
    automation: AutomationFull,
    contactId: string,
    event: IncomingEvent,
    account: { igUserId: string; accessToken: string | null },
    text: string,
    sourceKey: string,
    quickReplies: QuickReply[] = [],
  ) {
    if (await this.messageExists(sourceKey)) {
      this.logger.log(`Mensagem duplicada ignorada: ${sourceKey}`);
      return;
    }

    const messageId = await this.reserveMessage({
      userId,
      contactId,
      automationId: automation.id,
      sourceKey,
      body: text,
      status: MessageStatus.pending,
    });
    if (!messageId) return;

    let status: MessageStatus = MessageStatus.sent;
    let error: string | undefined;

    if (account.accessToken) {
      if (!event.senderId && !event.commentId) {
        status = MessageStatus.failed;
        error = 'Evento sem senderId/commentId';
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
          quickReplies,
        });
        status = res.ok ? MessageStatus.delivered : MessageStatus.failed;
        error = res.error;
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

    await this.prisma.message.update({
      where: { id: messageId },
      data: {
        body:
          status === MessageStatus.failed && error
            ? `${text}\n\n[erro Meta] ${error}`
            : text,
        status,
      },
    });
    if (status !== MessageStatus.failed) {
      await this.logEvent(userId, AnalyticsEventType.message_sent);
    }
  }

  private async messageExists(sourceKey: string) {
    const count = await this.prisma.message.count({ where: { sourceKey } });
    return count > 0;
  }

  private async reserveMessage(data: Prisma.MessageUncheckedCreateInput) {
    try {
      const message = await this.prisma.message.create({ data });
      return message.id;
    } catch (err) {
      if (
        err &&
        typeof err === 'object' &&
        'code' in err &&
        err.code === 'P2002'
      ) {
        this.logger.log(
          `Mensagem duplicada bloqueada pelo banco: ${data.sourceKey}`,
        );
        return null;
      }
      throw err;
    }
  }

  private logEvent(userId: string, type: AnalyticsEventType) {
    return this.prisma.analyticsEvent.create({ data: { userId, type } });
  }
}
