import { Injectable, Logger, OnModuleInit } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import * as Minio from 'minio'

/**
 * Armazenamento de arquivos no MinIO (S3-compatível). Reusa o endpoint/credenciais
 * do Postgram, mas com bucket próprio do InstaAuto (MINIO_BUCKET, default
 * "instauto-files"). Objetos têm leitura pública para servir nas DMs.
 */
@Injectable()
export class MinioService implements OnModuleInit {
  private readonly logger = new Logger(MinioService.name)
  private readonly client: Minio.Client
  readonly bucket: string
  private readonly enabled: boolean

  constructor(private readonly config: ConfigService) {
    this.bucket = config.get<string>('MINIO_BUCKET') ?? 'instauto-files'
    const endpoint = config.get<string>('MINIO_ENDPOINT')
    this.enabled = Boolean(endpoint)

    this.client = new Minio.Client({
      endPoint: endpoint ?? 'localhost',
      port: Number(config.get<string>('MINIO_PORT') ?? 443),
      useSSL: (config.get<string>('MINIO_USE_SSL') ?? 'true') === 'true',
      accessKey: config.get<string>('MINIO_ACCESS_KEY') ?? '',
      secretKey: config.get<string>('MINIO_SECRET_KEY') ?? '',
    })
  }

  async onModuleInit() {
    if (!this.enabled) {
      this.logger.warn('MinIO não configurado (MINIO_ENDPOINT ausente).')
      return
    }
    try {
      const exists = await this.client.bucketExists(this.bucket)
      if (!exists) {
        await this.client.makeBucket(this.bucket)
        this.logger.log(`Bucket "${this.bucket}" criado`)
      }
      const publicReadPolicy = JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { AWS: ['*'] },
            Action: ['s3:GetObject'],
            Resource: [`arn:aws:s3:::${this.bucket}/*`],
          },
        ],
      })
      await this.client.setBucketPolicy(this.bucket, publicReadPolicy)
      this.logger.log(`Bucket "${this.bucket}" pronto (leitura pública)`)
    } catch (err) {
      this.logger.error(
        `Erro ao inicializar MinIO: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  get isEnabled() {
    return this.enabled
  }

  async put(
    objectName: string,
    buffer: Buffer,
    mimeType: string,
  ): Promise<string> {
    await this.client.putObject(this.bucket, objectName, buffer, buffer.length, {
      'Content-Type': mimeType,
    })
    return this.publicUrl(objectName)
  }

  async delete(objectName: string): Promise<void> {
    try {
      await this.client.removeObject(this.bucket, objectName)
    } catch {
      /* objeto pode não existir */
    }
  }

  /** URL pública direta (bucket com leitura pública). */
  publicUrl(objectName: string): string {
    const base = (this.config.get<string>('MINIO_PUBLIC_URL') ?? '').replace(
      /\/+$/,
      '',
    )
    return `${base}/${this.bucket}/${objectName}`
  }
}
