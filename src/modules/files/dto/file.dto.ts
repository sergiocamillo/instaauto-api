import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
} from 'class-validator';
import { FileType } from '@generated/prisma/enums';

export class CreateFileDto {
  @ApiProperty()
  @IsString()
  @MaxLength(200)
  name: string;

  @ApiProperty({ enum: FileType })
  @IsEnum(FileType)
  type: FileType;

  @ApiProperty()
  @IsUrl({}, { message: 'URL inválida' })
  url: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  sizeLabel?: string;
}
