import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaClient } from '@generated/prisma';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool, type PoolConfig } from 'pg';

function isRemoteHost(connectionString: string): boolean {
  return /rlwy\.net|railway\.app|\.proxy\./i.test(connectionString);
}

function createPgPool(connectionString: string): Pool {
  const remote = isRemoteHost(connectionString);
  const config: PoolConfig = {
    connectionString,
    max: remote ? 5 : 10,
    idleTimeoutMillis: remote ? 20_000 : 30_000,
    connectionTimeoutMillis: 15_000,
    allowExitOnIdle: false,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    ...(remote ? { ssl: { rejectUnauthorized: false } } : {}),
  };
  return new Pool(config);
}

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);
  private readonly pool: Pool;

  constructor() {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL não está definida');
    }

    const pool = createPgPool(connectionString);
    const adapter = new PrismaPg(pool, {
      onPoolError: (err) =>
        new Logger(PrismaService.name).error(`Pool error: ${err.message}`),
      onConnectionError: (err) =>
        new Logger(PrismaService.name).warn(`Conn error: ${err.message}`),
    });

    super({ adapter });
    this.pool = pool;
  }

  async onModuleInit() {
    const maxAttempts = 3;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        await this.$connect();
        await this.$queryRaw`SELECT 1`;
        this.logger.log('Prisma conectado');
        return;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `Tentativa ${attempt + 1}/${maxAttempts} falhou: ${msg}`,
        );
        if (attempt === maxAttempts - 1) throw error;
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
    await this.pool.end();
  }
}
