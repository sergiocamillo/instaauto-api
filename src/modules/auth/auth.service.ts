import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes } from 'crypto';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { LoginDto, RegisterDto } from './dto/auth.dto';

const REFRESH_TTL_DAYS = Number(process.env.JWT_REFRESH_TTL_DAYS ?? 30);

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  private async issueTokens(user: { id: string; email: string }) {
    const accessToken = await this.jwt.signAsync(
      { sub: user.id, email: user.email },
      { expiresIn: (process.env.JWT_ACCESS_TTL ?? '15m') as `${number}m` },
    );

    const refreshToken = randomBytes(48).toString('base64url');
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + REFRESH_TTL_DAYS);

    await this.prisma.refreshToken.create({
      data: { userId: user.id, tokenHash: hashToken(refreshToken), expiresAt },
    });

    return { accessToken, refreshToken };
  }

  private publicUser(user: {
    id: string;
    email: string;
    name: string;
    avatarUrl: string | null;
  }) {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
    };
  }

  async register(dto: RegisterDto) {
    const existing = await this.prisma.user.findUnique({
      where: { email: dto.email.toLowerCase() },
    });
    if (existing) throw new ConflictException('E-mail já cadastrado');

    const user = await this.prisma.user.create({
      data: {
        email: dto.email.toLowerCase(),
        name: dto.name,
        passwordHash: await bcrypt.hash(dto.password, 12),
      },
    });

    const tokens = await this.issueTokens(user);
    return { user: this.publicUser(user), ...tokens };
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email.toLowerCase() },
    });
    if (!user || !user.passwordHash) {
      throw new UnauthorizedException('Credenciais inválidas');
    }
    const ok = await bcrypt.compare(dto.password, user.passwordHash);
    if (!ok) throw new UnauthorizedException('Credenciais inválidas');

    const tokens = await this.issueTokens(user);
    return { user: this.publicUser(user), ...tokens };
  }

  async refresh(refreshToken: string) {
    const tokenHash = hashToken(refreshToken);
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
      throw new UnauthorizedException('Refresh token inválido');
    }

    // Rotação: revoga o atual e emite um novo par.
    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    });

    const tokens = await this.issueTokens(stored.user);
    return { user: this.publicUser(stored.user), ...tokens };
  }

  async logout(refreshToken: string) {
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: hashToken(refreshToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { success: true };
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException();
    return this.publicUser(user);
  }
}
