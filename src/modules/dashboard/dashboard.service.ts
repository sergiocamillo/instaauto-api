import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AnalyticsEventType, AutomationStatus } from '@generated/prisma/enums';

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async stats(userId: string) {
    const [activeAutomations, messagesSent, commentsAgg, leads] =
      await Promise.all([
        this.prisma.automation.count({
          where: { userId, status: AutomationStatus.active },
        }),
        this.prisma.message.count({
          where: { userId, status: { not: 'failed' } },
        }),
        this.prisma.automation.aggregate({
          where: { userId },
          _sum: { executions: true },
        }),
        this.prisma.contact.count({ where: { userId } }),
      ]);

    return {
      activeAutomations,
      messagesSent,
      commentsCaptured: commentsAgg._sum.executions ?? 0,
      leads,
    };
  }

  /** Série dos últimos 7 dias (interações + mensagens) a partir de eventos. */
  async series(userId: string) {
    const since = new Date();
    since.setHours(0, 0, 0, 0);
    since.setDate(since.getDate() - 6);

    const events = await this.prisma.analyticsEvent.findMany({
      where: { userId, createdAt: { gte: since } },
      select: { type: true, createdAt: true },
    });

    const days: Record<string, { interactions: number; messages: number }> = {};
    for (let i = 0; i < 7; i++) {
      const d = new Date(since);
      d.setDate(since.getDate() + i);
      days[d.toISOString().slice(0, 10)] = { interactions: 0, messages: 0 };
    }

    for (const ev of events) {
      const key = ev.createdAt.toISOString().slice(0, 10);
      const bucket = days[key];
      if (!bucket) continue;
      bucket.interactions += 1;
      if (ev.type === AnalyticsEventType.message_sent) bucket.messages += 1;
    }

    return Object.entries(days).map(([date, v]) => ({ date, ...v }));
  }

  async overview(userId: string) {
    const [stats, series] = await Promise.all([
      this.stats(userId),
      this.series(userId),
    ]);
    return { stats, series };
  }
}
