import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { FilesService } from './files.service';
import { CreateFileDto } from './dto/file.dto';
import {
  CurrentUser,
  type AuthUser,
} from '../../common/decorators/current-user.decorator';

@ApiTags('files')
@ApiBearerAuth()
@Controller('files')
export class FilesController {
  constructor(private readonly service: FilesService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.service.list(user.id);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateFileDto) {
    return this.service.create(user.id, dto);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.remove(user.id, id);
  }
}
