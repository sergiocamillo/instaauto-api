import { Body, Controller, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';
import {
  CurrentUser,
  type AuthUser,
} from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { AutomationEngineService } from './automation-engine.service';

class SimulateDto {
  @IsString() text: string;
  @IsIn(['comment', 'message', 'story_reply']) kind:
    | 'comment'
    | 'message'
    | 'story_reply';
  @IsOptional() @IsString() senderUsername?: string;
  @IsOptional() @IsString() mediaRef?: string;
  @IsOptional() @IsString() commentId?: string;
}

/**
 * Endpoint de teste: dispara o motor de automação como se um evento da Meta
 * tivesse chegado para a conta conectada do usuário. Útil para validar fluxos
 * sem depender de webhooks reais.
 */
@ApiTags('meta')
@ApiBearerAuth()
@Controller('meta/simulate')
export class SimulateController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly engine: AutomationEngineService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Simula um evento de webhook (teste)' })
  async simulate(@CurrentUser() user: AuthUser, @Body() dto: SimulateDto) {
    const account = await this.prisma.connectedAccount.findFirst({
      where: { userId: user.id, platform: 'instagram' },
    });

    // Usa o igUserId real se houver; senão um placeholder estável por usuário.
    const igUserId = account?.igUserId ?? `sim_${user.id}`;
    if (!account?.igUserId) {
      // Garante uma conta "conectada" simulada para o motor encontrar.
      await this.prisma.connectedAccount.upsert({
        where: {
          userId_platform: { userId: user.id, platform: 'instagram' },
        },
        create: {
          userId: user.id,
          platform: 'instagram',
          handle: '@simulado',
          igUserId,
          status: 'connected',
        },
        update: { igUserId, status: 'connected' },
      });
    }

    await this.engine.process({
      igUserId,
      senderId: `igsid_${Date.now()}`,
      senderUsername: dto.senderUsername ?? '@lead_teste',
      text: dto.text,
      kind: dto.kind,
      mediaRef: dto.mediaRef,
      commentId:
        dto.commentId ??
        (dto.kind === 'comment' ? `comment_${Date.now()}` : undefined),
    });

    return { processed: true };
  }
}
