import { Module } from '@nestjs/common';
import { MetaModule } from '../meta/meta.module';
import { AccountsController } from './accounts.controller';
import { AccountsService } from './accounts.service';

@Module({
  imports: [MetaModule],
  controllers: [AccountsController],
  providers: [AccountsService],
})
export class AccountsModule {}
