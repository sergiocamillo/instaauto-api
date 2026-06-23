import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateFileDto } from './dto/file.dto';

@Injectable()
export class FilesService {
  constructor(private readonly prisma: PrismaService) {}

  list(userId: string) {
    return this.prisma.file.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  create(userId: string, dto: CreateFileDto) {
    return this.prisma.file.create({
      data: {
        userId,
        name: dto.name,
        type: dto.type,
        url: dto.url,
        sizeLabel: dto.sizeLabel ?? '—',
      },
    });
  }

  async remove(userId: string, id: string) {
    await this.prisma.file.deleteMany({ where: { id, userId } });
    return { success: true };
  }
}
