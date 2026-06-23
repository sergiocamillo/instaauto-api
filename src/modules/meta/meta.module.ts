import { Module } from '@nestjs/common';
import { ContactsModule } from '../contacts/contacts.module';
import { GraphService } from './graph.service';
import { AutomationEngineService } from './automation-engine.service';
import { WebhookController } from './webhook.controller';
import { SimulateController } from './simulate.controller';

@Module({
  imports: [ContactsModule],
  controllers: [WebhookController, SimulateController],
  providers: [GraphService, AutomationEngineService],
  exports: [GraphService, AutomationEngineService],
})
export class MetaModule {}
