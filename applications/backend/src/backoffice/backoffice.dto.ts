import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsString, Length, Matches, Max, Min, ValidateIf } from 'class-validator';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;
const integer = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;

export class AdminGroupsQueryDto {
  @ValidateIf((_object, value): boolean => value !== undefined)
  @Transform(trim)
  @IsString()
  @Length(0, 80)
  q?: string;

  @Transform(integer)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;

  @Transform(integer)
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  offset: number = 0;
}

export class AdminUsersQueryDto extends AdminGroupsQueryDto {
  limit: number = 25;

  @IsIn(['all', 'active', 'disabled'])
  status: 'all' | 'active' | 'disabled' = 'all';
}

export class AdminPasswordDto {
  @IsString()
  @Length(15, 128)
  password!: string;
}

export class AdminCreateUserDto extends AdminPasswordDto {
  @Transform(trim)
  @IsString()
  @Length(1, 80)
  display_name!: string;

  @IsString()
  @Length(1)
  group_name!: string;

  @ValidateIf((_object, value): boolean => value !== undefined)
  @Transform(({ value }: { value: unknown }): unknown =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsString()
  @Length(3, 32)
  @Matches(/^[a-z0-9._-]+$/)
  login?: string;
}

export class AdminEmptyDto {}

export class AdminGroupDto {
  id!: string;
  name!: string;
}

export class AdminUserDto {
  id!: string;
  login!: string;
  display_name!: string;
  @ApiProperty({ enum: ['user', 'admin'] })
  role!: 'user' | 'admin';
  @ApiProperty({ enum: ['active', 'disabled'] })
  status!: 'active' | 'disabled';
  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  disabled_at!: string | null;
  groups!: AdminGroupDto[];
  created_at!: string;
  updated_at!: string;
}

export class AdminUserResponseDto {
  user!: AdminUserDto;
}

export class AdminUsersResponseDto {
  users!: AdminUserDto[];
  total!: number;
}

export class AdminGroupsResponseDto {
  groups!: AdminGroupDto[];
  total!: number;
}
