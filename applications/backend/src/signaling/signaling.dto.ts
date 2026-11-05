import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsObject,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

import { CallIdDto } from '../direct-calls/direct-calls.dto.js';

export class WsRequestDto {
  @IsString() @Length(1, 128) request_id!: string;
  @IsString() @Length(1, 64) type!: string;
  @IsObject() payload!: Record<string, unknown>;
}

export class EmptyDto {}

export class RegisterDeviceDto {
  @ValidateIf((_object, value): boolean => value !== null) @IsUUID() device_id!: string | null;
}

export class PushTokenDto {
  @ValidateIf((_object, value): boolean => value !== null)
  @IsString()
  @Length(2, 512)
  @Matches(/^(?:[0-9a-fA-F]{2})+$/)
  voip_token!: string | null;
  @IsIn(['sandbox', 'production']) environment!: string;
}

export class WebPushSubscriptionDto {
  @IsString() @Length(1, 4096) endpoint!: string;
  @IsString() @Length(87, 87) p256dh!: string;
  @IsString() @Length(22, 22) auth!: string;
}

export class WebPushDto {
  @ValidateIf((_object, value): boolean => value !== null)
  @IsObject()
  @ValidateNested()
  @Type((): typeof WebPushSubscriptionDto => WebPushSubscriptionDto)
  subscription!: WebPushSubscriptionDto | null;
}

export class RtcAttemptDto extends CallIdDto {
  @IsUUID() negotiation_id!: string;
}

export class RtcSdpDto extends RtcAttemptDto {
  @IsString() @Length(1, 65536) sdp!: string;
}

export class IceCandidateDto {
  @IsString() @MaxLength(4096) candidate!: string;
  @ValidateIf((_object, value): boolean => value !== null) @IsString() @MaxLength(256) sdp_mid!:
    string | null;
  @ValidateIf((_object, value): boolean => value !== null)
  @IsInt()
  @Min(0)
  @Max(65535)
  sdp_mline_index!: number | null;
}

export class RtcIceDto extends RtcAttemptDto {
  @ValidateIf((_object, value): boolean => value !== null)
  @IsObject()
  @ValidateNested()
  @Type((): typeof IceCandidateDto => IceCandidateDto)
  candidate!: IceCandidateDto | null;
}
