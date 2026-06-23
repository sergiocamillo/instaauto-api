import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AutomationsService } from './automations.service';
import {
  CreateAutomationDto,
  ToggleStatusDto,
  UpdateAutomationDto,
} from './dto/automation.dto';
import {
  CurrentUser,
  type AuthUser,
} from '../../common/decorators/current-user.decorator';
import { RequireConnectedAccount } from '../../common/decorators/require-connected-account.decorator';

@ApiTags('automations')
@ApiBearerAuth()
@Controller('automations')
export class AutomationsController {
  constructor(private readonly service: AutomationsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.service.list(user.id);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.get(user.id, id);
  }

  @Post()
  @RequireConnectedAccount()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateAutomationDto) {
    return this.service.create(user.id, dto);
  }

  @Put(':id')
  @RequireConnectedAccount()
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateAutomationDto,
  ) {
    return this.service.update(user.id, id, dto);
  }

  @Patch(':id/status')
  @RequireConnectedAccount()
  setStatus(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: ToggleStatusDto,
  ) {
    return this.service.setStatus(user.id, id, dto.status);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.remove(user.id, id);
  }
}
