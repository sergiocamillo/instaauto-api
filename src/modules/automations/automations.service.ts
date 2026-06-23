import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateAutomationDto, UpdateAutomationDto } from './dto/automation.dto';
import { AutomationStatus, Prisma } from '@generated/prisma';

const automationInclude = {
  trigger: true,
  actions: { orderBy: { order: 'asc' } },
} satisfies Prisma.AutomationInclude;

@Injectable()
export class AutomationsService {
  constructor(private readonly prisma: PrismaService) {}

  list(userId: string) {
    return this.prisma.automation.findMany({
      where: { userId },
      include: automationInclude,
      orderBy: { createdAt: 'desc' },
    });
  }

  async get(userId: string, id: string) {
    const automation = await this.prisma.automation.findFirst({
      where: { id, userId },
      include: automationInclude,
    });
    if (!automation) throw new NotFoundException('Automação não encontrada');
    return automation;
  }

  create(userId: string, dto: CreateAutomationDto) {
    return this.prisma.automation.create({
      data: {
        userId,
        name: dto.name,
        status: dto.status ?? AutomationStatus.active,
        trigger: {
          create: {
            type: dto.trigger.type,
            targetRef: dto.trigger.targetRef,
            keywordMatch: dto.trigger.keywordMatch,
            keywords: dto.trigger.keywords,
          },
        },
        actions: {
          create: dto.actions.map((a, i) => ({
            type: a.type,
            order: a.order ?? i,
            config: (a.config ?? {}) as Prisma.InputJsonValue,
          })),
        },
      },
      include: automationInclude,
    });
  }

  async update(userId: string, id: string, dto: UpdateAutomationDto) {
    await this.get(userId, id); // valida posse

    // Recria trigger/actions de forma transacional quando enviados.
    return this.prisma.$transaction(async (tx) => {
      await tx.automation.update({
        where: { id },
        data: {
          name: dto.name,
          status: dto.status,
        },
      });

      if (dto.trigger) {
        await tx.automationTrigger.upsert({
          where: { automationId: id },
          create: {
            automationId: id,
            type: dto.trigger.type,
            targetRef: dto.trigger.targetRef,
            keywordMatch: dto.trigger.keywordMatch,
            keywords: dto.trigger.keywords,
          },
          update: {
            type: dto.trigger.type,
            targetRef: dto.trigger.targetRef,
            keywordMatch: dto.trigger.keywordMatch,
            keywords: dto.trigger.keywords,
          },
        });
      }

      if (dto.actions) {
        await tx.automationAction.deleteMany({ where: { automationId: id } });
        await tx.automationAction.createMany({
          data: dto.actions.map((a, i) => ({
            automationId: id,
            type: a.type,
            order: a.order ?? i,
            config: (a.config ?? {}) as Prisma.InputJsonValue,
          })),
        });
      }

      return tx.automation.findUniqueOrThrow({
        where: { id },
        include: automationInclude,
      });
    });
  }

  async setStatus(userId: string, id: string, status: AutomationStatus) {
    await this.get(userId, id);
    return this.prisma.automation.update({
      where: { id },
      data: { status },
      include: automationInclude,
    });
  }

  async remove(userId: string, id: string) {
    await this.get(userId, id);
    await this.prisma.automation.delete({ where: { id } });
    return { success: true };
  }
}
