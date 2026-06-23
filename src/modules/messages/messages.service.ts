import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MessageStatus, Prisma } from '@generated/prisma';

@Injectable()
export class MessagesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string, status?: MessageStatus) {
    const where: Prisma.MessageWhereInput = { userId };
    if (status) where.status = status;

    const messages = await this.prisma.message.findMany({
      where,
      include: { contact: true, automation: true },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });

    return messages.map((m) => ({
      id: m.id,
      body: m.body,
      status: m.status,
      createdAt: m.createdAt,
      contactName: m.contact?.name ?? 'Desconhecido',
      contactUsername: m.contact?.username ?? '',
      automationName: m.automation?.name ?? '—',
    }));
  }
}
