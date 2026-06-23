import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { AppController } from './app.controller';
import { ConnectedAccountGuard } from './common/guards/connected-account.guard';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { PrismaModule } from './modules/prisma/prisma.module';
import { StorageModule } from './modules/storage/storage.module';
import { AuthModule } from './modules/auth/auth.module';
import { AccountsModule } from './modules/accounts/accounts.module';
import { AutomationsModule } from './modules/automations/automations.module';
import { ContactsModule } from './modules/contacts/contacts.module';
import { MessagesModule } from './modules/messages/messages.module';
import { FilesModule } from './modules/files/files.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { MetaModule } from './modules/meta/meta.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
    PrismaModule,
    StorageModule,
    AuthModule,
    AccountsModule,
    AutomationsModule,
    ContactsModule,
    MessagesModule,
    FilesModule,
    DashboardModule,
    MetaModule,
  ],
  controllers: [AppController],
  providers: [
    // Ordem importa: JWT popula req.user antes do ConnectedAccountGuard.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: ConnectedAccountGuard },
  ],
})
export class AppModule {}
