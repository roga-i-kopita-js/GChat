import { ApiProperty } from '@nestjs/swagger';
import {
  IsAscii,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

import type { EndReason } from './direct-calls.dto.js';

export type HistoryFilter = 'all' | 'missed';

export type HistoryOutcome =
  'completed' | 'missed' | 'unanswered' | 'cancelled' | 'rejected' | 'failed';

export class CallHistoryQueryDto {
  @IsOptional() @IsIn(['all', 'missed']) filter: HistoryFilter = 'all';
  @IsOptional() @IsString() @Matches(/^[0-9]+$/) limit = '30';
  @IsOptional() @IsString() @IsAscii() @MinLength(1) @MaxLength(2048) cursor?: string;
}

export class CallHistoryParamsDto {
  @IsUUID() call_id!: string;
}

export class CallHistoryItemDto {
  @ApiProperty({ format: 'uuid' }) call_id!: string;
  @ApiProperty({ type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }) version!: number;
  @ApiProperty({ format: 'uuid' }) peer_id!: string;
  peer_display_name!: string;
  @ApiProperty({ enum: ['incoming', 'outgoing'] }) direction!: 'incoming' | 'outgoing';
  @ApiProperty({ enum: ['completed', 'missed', 'unanswered', 'cancelled', 'rejected', 'failed'] })
  outcome!: HistoryOutcome;
  @ApiProperty({ format: 'date-time' }) created_at!: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) started_at!: string | null;
  @ApiProperty({ format: 'date-time' }) ended_at!: string;
  @ApiProperty({
    enum: [
      'cancelled',
      'rejected',
      'no_answer',
      'connection_timeout',
      'hangup',
      'connection_lost',
      'session_revoked',
      'account_disabled',
    ],
  })
  end_reason!: EndReason;
  @ApiProperty({ type: 'integer', nullable: true, minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
  duration_seconds!: number | null;
}

export class CallHistoryListResponseDto {
  items!: CallHistoryItemDto[];
  @ApiProperty({ type: String, nullable: true }) next_cursor!: string | null;
}

export class CallHistoryResponseDto {
  item!: CallHistoryItemDto;
}
