import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import {
  ActionType,
  AutomationStatus,
  KeywordMatch,
  TriggerType,
} from '@generated/prisma/enums';

export class TriggerDto {
  @ApiProperty({ enum: TriggerType })
  @IsEnum(TriggerType)
  type: TriggerType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  targetRef?: string;

  @ApiProperty({ enum: KeywordMatch })
  @IsEnum(KeywordMatch)
  keywordMatch: KeywordMatch;

  @ApiProperty({ type: [String] })
  @IsArray()
  @IsString({ each: true })
  keywords: string[];
}

export class ActionDto {
  @ApiProperty({ enum: ActionType })
  @IsEnum(ActionType)
  type: ActionType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  order?: number;

  @ApiProperty({ type: Object })
  @IsObject()
  config: Record<string, unknown>;
}

export class CreateAutomationDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name: string;

  @ApiPropertyOptional({ enum: AutomationStatus })
  @IsOptional()
  @IsEnum(AutomationStatus)
  status?: AutomationStatus;

  @ApiProperty({ type: TriggerDto })
  @ValidateNested()
  @Type(() => TriggerDto)
  trigger: TriggerDto;

  @ApiProperty({ type: [ActionDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ActionDto)
  actions: ActionDto[];
}

export class UpdateAutomationDto extends PartialType(CreateAutomationDto) {}

export class ToggleStatusDto {
  @ApiProperty({ enum: AutomationStatus })
  @IsEnum(AutomationStatus)
  status: AutomationStatus;
}
