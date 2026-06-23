import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags, ApiQuery } from '@nestjs/swagger';
import { MessagesService } from './messages.service';
import { MessageStatus } from '@generated/prisma/enums';
import {
  CurrentUser,
  type AuthUser,
} from '../../common/decorators/current-user.decorator';

@ApiTags('messages')
@ApiBearerAuth()
@Controller('messages')
export class MessagesController {
  constructor(private readonly service: MessagesService) {}

  @Get()
  @ApiQuery({ name: 'status', enum: MessageStatus, required: false })
  list(@CurrentUser() user: AuthUser, @Query('status') status?: MessageStatus) {
    return this.service.list(user.id, status);
  }
}
