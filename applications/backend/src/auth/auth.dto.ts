import { Transform } from 'class-transformer';
import { IsString, IsUUID, Length, Matches } from 'class-validator';

export class LoginDto {
  @Transform(({ value }: { value: unknown }): unknown =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsString()
  @Length(3, 32)
  @Matches(/^[a-z0-9._-]+$/)
  login!: string;
  @IsString()
  @Length(15, 128)
  password!: string;
}

export class RefreshTokenDto {
  @IsString()
  @Length(1, 200)
  refresh_token!: string;
}

export class RefreshDto extends RefreshTokenDto {
  @Transform(({ value }: { value: unknown }): unknown =>
    typeof value === 'string' ? value.toLowerCase() : value,
  )
  @IsUUID()
  request_id!: string;
}

export class TokensDto {
  access_token!: string;
  refresh_token!: string;
  token_type!: 'Bearer';
}
