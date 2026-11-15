import { stickerIds } from '@gchat/dialog-assets';
import { reactionEmojis } from '@gchat/dialog-assets';
import { ApiExtraModels, ApiProperty, getSchemaPath } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

import type { MessageContent } from './dialogs.validation.js';

export class ForwardMessageDto {
  @IsUUID() client_message_id!: string;
  @IsUUID() source_dialog_id!: string;
  @IsUUID() source_message_id!: string;
  @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) expected_source_version!: number;
}

export class SetReactionDto {
  @IsUUID() client_reaction_id!: string;
  @IsString() @ApiProperty({ enum: [...reactionEmojis] }) emoji!: string;
  @IsBoolean() selected!: boolean;
  @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER) expected_version!: number;
}

export class ForwardAuthorDto {
  id!: string;
  display_name!: string;
}

export class ForwardInfoDto {
  @ApiProperty({ type: () => ForwardAuthorDto, nullable: true }) author!: ForwardAuthorDto | null;
}

export class ReactionDto {
  emoji!: string;
  user_ids!: string[];
}

export class OwnReactionStateDto {
  emoji!: string;
  selected!: boolean;
  version!: number;
  last_operation_id!: string;
}

export class MessageReactionsResponseDto {
  @ApiProperty({ type: () => [MessageDto] }) messages!: MessageDto[];
  next_reaction_sequence!: number;
  has_more!: boolean;
}

export class CreateDialogDto {
  @IsUUID() peer_id!: string;
}

export class TextContentDto {
  @ApiProperty({ enum: ['text'] }) kind!: 'text';
  @ApiProperty({ maxLength: 4000 }) text!: string;
}

export class StickerContentDto {
  @ApiProperty({ enum: ['sticker'] }) kind!: 'sticker';
  @ApiProperty({ enum: [...stickerIds] }) sticker_id!: string;
}

export class ReplyToDto {
  @IsUUID() message_id!: string;
  @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) expected_version!: number;
}

@ApiExtraModels(TextContentDto, StickerContentDto)
export class ReplyInfoDto {
  @ApiProperty({ format: 'uuid' }) message_id!: string;
  @ApiProperty({ type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER }) sequence!: number;
  @ApiProperty({ type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER }) version!: number;
  @ApiProperty({ format: 'uuid' }) sender_id!: string;
  @ApiProperty({ minLength: 1, maxLength: 80 }) sender_display_name!: string;
  @ApiProperty({
    oneOf: [{ $ref: getSchemaPath(TextContentDto) }, { $ref: getSchemaPath(StickerContentDto) }],
  })
  content!: MessageContent;
}

@ApiExtraModels(TextContentDto, StickerContentDto)
export class SendMessageDto {
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => ReplyToDto)
  @ApiProperty({ type: () => ReplyToDto, required: false, nullable: true })
  reply_to?: ReplyToDto | null;
  @IsUUID() client_message_id!: string;
  @IsObject()
  @ApiProperty({
    oneOf: [{ $ref: getSchemaPath(TextContentDto) }, { $ref: getSchemaPath(StickerContentDto) }],
  })
  content!: MessageContent;
}

@ApiExtraModels(TextContentDto)
export class EditMessageDto {
  @IsUUID() client_edit_id!: string;
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  @ApiProperty({ type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER })
  expected_version!: number;
  @IsObject()
  @ApiProperty({ type: () => TextContentDto })
  content!: { kind: 'text'; text: string };
}

export class MessageEditsResponseDto {
  @ApiProperty({ type: () => [MessageDto] }) messages!: MessageDto[];
  @ApiProperty({ type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
  next_edit_sequence!: number;
  has_more!: boolean;
}

export class ReadDialogDto {
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  @ApiProperty({ type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
  sequence!: number;
}

@ApiExtraModels(TextContentDto, StickerContentDto)
export class MessageDto {
  @ApiProperty({ type: () => ReplyInfoDto, nullable: true }) reply!: ReplyInfoDto | null;
  @ApiProperty({ type: () => ForwardInfoDto, nullable: true }) forward!: ForwardInfoDto | null;
  reaction_version!: number;
  reaction_sequence!: number;
  @ApiProperty({ type: () => [ReactionDto] }) reactions!: ReactionDto[];
  @ApiProperty({ type: () => [OwnReactionStateDto] }) own_reaction_states!: OwnReactionStateDto[];
  message_id!: string;
  dialog_id!: string;
  client_message_id!: string;
  @ApiProperty({ type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER }) sequence!: number;
  sender_id!: string;
  @ApiProperty({ type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER }) version!: number;
  @ApiProperty({ type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
  edit_sequence!: number;
  @ApiProperty({ type: String, nullable: true }) edited_at!: string | null;
  @ApiProperty({ type: String, nullable: true }) last_edit_id!: string | null;
  created_at!: string;
  @ApiProperty({
    oneOf: [{ $ref: getSchemaPath(TextContentDto) }, { $ref: getSchemaPath(StickerContentDto) }],
  })
  content!: MessageContent;
  @ApiProperty({ enum: ['sent', 'read'] }) status!: 'sent' | 'read';
}

export class DialogDto {
  dialog_id!: string;
  peer_id!: string;
  peer_display_name!: string;
  has_unread_messages!: boolean;
  @ApiProperty({ type: () => MessageDto, nullable: true }) last_message!: MessageDto | null;
  created_at!: string;
  @ApiProperty({ type: String, nullable: true }) last_message_at!: string | null;
  @ApiProperty({ type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
  last_sequence!: number;
  @ApiProperty({ type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
  last_read_sequence!: number;
  @ApiProperty({ type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
  peer_last_read_sequence!: number;
}

export class DialogResponseDto {
  dialog!: DialogDto;
}

export class DialogListResponseDto {
  dialogs!: DialogDto[];
  has_more!: boolean;
}

export class MessageResponseDto {
  message!: MessageDto;
}

export class HistoryResponseDto {
  messages!: MessageDto[];
  has_more!: boolean;
}

export class ReadResponseDto {
  @ApiProperty({ type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
  last_read_sequence!: number;
}

export class DialogPermissionsDto {
  can_read!: boolean;
  can_send!: boolean;
}

export class PermissionsResponseDto {
  dialogs!: DialogPermissionsDto;
}
