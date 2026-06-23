import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, MinLength, MaxLength } from 'class-validator';

export class RegisterDto {
  @ApiProperty({ example: 'voce@exemplo.com' })
  @IsEmail({}, { message: 'E-mail inválido' })
  email: string;

  @ApiProperty({ example: 'Seu Nome' })
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name: string;

  @ApiProperty({ minLength: 6 })
  @IsString()
  @MinLength(6, { message: 'A senha deve ter ao menos 6 caracteres' })
  @MaxLength(128)
  password: string;
}

export class LoginDto {
  @ApiProperty({ example: 'voce@exemplo.com' })
  @IsEmail({}, { message: 'E-mail inválido' })
  email: string;

  @ApiProperty()
  @IsString()
  @MinLength(6)
  password: string;
}

export class RefreshDto {
  @ApiProperty()
  @IsString()
  refreshToken: string;
}
