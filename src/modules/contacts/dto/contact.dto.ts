import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateContactDto {
  @ApiProperty()
  @IsString()
  @MaxLength(120)
  name: string;

  @ApiProperty()
  @IsString()
  @MaxLength(120)
  username: string;

  @ApiProperty()
  @IsString()
  origin: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  keywordUsed?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  automationName?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];
}

export class ContactQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  q?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  tag?: string;
}
