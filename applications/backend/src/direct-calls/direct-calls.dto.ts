import { IsBoolean, IsInt, IsUUID, Max, Min, ValidateIf } from 'class-validator';

export type CallState = 'ringing' | 'connecting' | 'active' | 'ended';

export type EndReason =
  | 'cancelled'
  | 'rejected'
  | 'no_answer'
  | 'connection_timeout'
  | 'hangup'
  | 'connection_lost'
  | 'session_revoked'
  | 'account_disabled';

export type CallActor = { userId: string; sessionId: string; deviceId: string };

export class CallIdDto {
  @IsUUID() call_id!: string;
}

export class CallCreateDto {
  @IsUUID() recipient_id!: string;
}

export class CallConnectedDto extends CallIdDto {
  @IsUUID() negotiation_id!: string;
}

export class CallPingDto extends CallIdDto {
  @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) sequence!: number;
  @IsBoolean() audio_connected!: boolean;
  @ValidateIf((_object, value): boolean => value !== null) @IsUUID() recovery_id!: string | null;
}

export class CallDto {
  call_id!: string;
  state!: CallState;
  caller_id!: string;
  recipient_id!: string;
  created_at!: string;
  started_at!: string | null;
  ended_at!: string | null;
  end_reason!: EndReason | null;
  recovery_id!: string | null;
  recovery_deadline!: string | null;
  ringing_deadline!: string | null;
  connecting_deadline!: string | null;
  version!: number;
}

export class CallPingResponseDto {
  state!: CallState;
  version!: number;
  recovery_id!: string | null;
  recovery_deadline!: string | null;
}

export class CallIceConfigDto {
  ice_servers!: { urls: string[]; username: string; credential: string }[];
  expires_at!: string;
}
