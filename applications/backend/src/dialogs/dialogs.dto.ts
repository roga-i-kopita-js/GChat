import { stickerIds } from '@gchat/dialog-assets';
import { ApiExtraModels, ApiProperty, getSchemaPath } from '@nestjs/swagger';
import { IsInt, IsObject, IsUUID, Max, Min } from 'class-validator';

import type { MessageContent } from './dialogs.validation.js';

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

@ApiExtraModels(TextContentDto, StickerContentDto)
export class SendMessageDto {
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
