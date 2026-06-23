import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ContactsService } from './contacts.service';
import { ContactQueryDto, CreateContactDto } from './dto/contact.dto';
import {
  CurrentUser,
  type AuthUser,
} from '../../common/decorators/current-user.decorator';

@ApiTags('contacts')
@ApiBearerAuth()
@Controller('contacts')
export class ContactsController {
  constructor(private readonly service: ContactsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() query: ContactQueryDto) {
    return this.service.list(user.id, query);
  }

  @Get('tags')
  tags(@CurrentUser() user: AuthUser) {
    return this.service.tags(user.id);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateContactDto) {
    return this.service.create(user.id, dto);
  }
}
