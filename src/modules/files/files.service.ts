import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common'
import { randomBytes } from 'crypto'
import { PrismaService } from '../prisma/prisma.service'
import { MinioService } from '../storage/minio.service'
import { CreateFileDto } from './dto/file.dto'
import { FileType } from '@generated/prisma/enums'

function detectType(mime: string): FileType {
  if (mime.startsWith('image/')) return FileType.image
  if (mime.startsWith('video/')) return FileType.video
  if (mime === 'application/pdf') return FileType.pdf
  return FileType.document
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

@Injectable()
export class FilesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly minio: MinioService,
  ) {}

  list(userId: string) {
    return this.prisma.file.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    })
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
    })
  }

  /** Recebe um arquivo, sobe no MinIO e registra no banco. */
  async upload(userId: string, file?: Express.Multer.File) {
    if (!file) throw new BadRequestException('Arquivo ausente')
    if (!this.minio.isEnabled) {
      throw new ServiceUnavailableException(
        'Armazenamento (MinIO) não configurado no servidor.',
      )
    }

    const objectName = `${userId}/${randomBytes(6).toString('hex')}-${slugify(
      file.originalname,
    )}`
    const url = await this.minio.put(objectName, file.buffer, file.mimetype)

    return this.prisma.file.create({
      data: {
        userId,
        name: file.originalname,
        type: detectType(file.mimetype),
        url,
        sizeLabel: humanSize(file.size),
      },
    })
  }

  async remove(userId: string, id: string) {
    await this.prisma.file.deleteMany({ where: { id, userId } })
    return { success: true }
  }
}
