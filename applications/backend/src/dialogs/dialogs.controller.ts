import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { AuthGuard, type AuthIdentity } from '../auth/auth.guard.js';
import { ErrorResponseDto } from '../error/error.dto.js';
import { ErrorService } from '../error/error.service.js';
import {
  CreateDialogDto,
  DialogListResponseDto,
  DialogResponseDto,
  EditMessageDto,
  HistoryResponseDto,
  MessageEditsResponseDto,
  MessageResponseDto,
  PermissionsResponseDto,
  ReadDialogDto,
  ReadResponseDto,
  SendMessageDto,
} from './dialogs.dto.js';
import { DialogsService } from './dialogs.service.js';
import { contentValue, queryInteger } from './dialogs.validation.js';
interface Request {
  user: AuthIdentity;
}
interface StatusResponse {
  status(code: number): unknown;
}

@ApiTags('Dialogs')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@ApiBadRequestResponse({ type: ErrorResponseDto })
@ApiUnauthorizedResponse({ type: ErrorResponseDto })
@ApiForbiddenResponse({ type: ErrorResponseDto })
@ApiNotFoundResponse({ type: ErrorResponseDto })
@ApiTooManyRequestsResponse({
  type: ErrorResponseDto,
  headers: { 'Retry-After': { schema: { type: 'integer' } } },
})
@ApiServiceUnavailableResponse({ type: ErrorResponseDto })
@Controller('dialogs')
export class DialogsController {
  constructor(
    private readonly dialogs: DialogsService,
    private readonly error: ErrorService,
  ) {}

  @Post()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ operationId: 'dialogsCreate' })
  @ApiOkResponse({ type: DialogResponseDto })
  @ApiCreatedResponse({ type: DialogResponseDto })
  async create(
    @Req() req: Request,
    @Body() input: CreateDialogDto,
    @Res({ passthrough: true }) res: StatusResponse,
  ): Promise<DialogResponseDto> {
    const result = await this.dialogs.create(req.user, input.peer_id.toLowerCase());

    const { created: resultCreated } = result;

    res.status(resultCreated ? 201 : 200);

    const { dialog: resultDialog } = result;

    return { dialog: resultDialog };
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ operationId: 'dialogsList' })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    schema: { type: 'integer', minimum: 1, maximum: 100, default: 30 },
  })
  @ApiQuery({
    name: 'offset',
    required: false,
    type: Number,
    schema: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER, default: 0 },
  })
  list(
    @Req() req: Request,
    @Query() query: Record<string, unknown>,
  ): Promise<DialogListResponseDto> {
    return this.dialogs.list(
      req.user,
      this.limit(query.limit),
      queryInteger(query.offset, 'offset', 0, this.error)!,
    );
  }

  @Get(':dialog_id')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ operationId: 'dialogsGet' })
  get(
    @Req() req: Request,
    @Param('dialog_id', new ParseUUIDPipe()) id: string,
  ): Promise<DialogResponseDto> {
    return this.dialogs.get(req.user, id.toLowerCase());
  }

  @Get(':dialog_id/permissions')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ operationId: 'dialogsPermissions' })
  permissions(
    @Req() req: Request,
    @Param('dialog_id', new ParseUUIDPipe()) id: string,
  ): Promise<PermissionsResponseDto> {
    return this.dialogs.permissions(req.user, id.toLowerCase());
  }

  @Post(':dialog_id/messages')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ operationId: 'dialogsSendMessage' })
  @ApiOkResponse({ type: MessageResponseDto })
  @ApiCreatedResponse({ type: MessageResponseDto })
  @ApiResponse({ status: 413, type: ErrorResponseDto })
  async send(
    @Req() req: Request,
    @Param('dialog_id', new ParseUUIDPipe()) id: string,
    @Body() input: SendMessageDto,
    @Res({ passthrough: true }) res: StatusResponse,
  ): Promise<MessageResponseDto> {
    const content = contentValue(input.content, this.error);
    const result = await this.dialogs.send(req.user, id.toLowerCase(), {
      client_message_id: input.client_message_id.toLowerCase(),
      content,
    });

    const { created: resultCreated2 } = result;

    res.status(resultCreated2 ? 201 : 200);

    const { message: resultMessage } = result;

    return { message: resultMessage };
  }

  @Get(':dialog_id/messages')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ operationId: 'dialogsHistory' })
  @ApiQuery({
    name: 'limit',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: 100, default: 30 },
  })
  @ApiQuery({
    name: 'after_sequence',
    required: false,
    schema: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  })
  @ApiQuery({
    name: 'before_sequence',
    required: false,
    schema: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  })
  history(
    @Req() req: Request,
    @Param('dialog_id', new ParseUUIDPipe()) id: string,
    @Query() query: Record<string, unknown>,
  ): Promise<HistoryResponseDto> {
    const after = queryInteger(query.after_sequence, 'after_sequence', undefined, this.error);
    const before = queryInteger(query.before_sequence, 'before_sequence', undefined, this.error);

    if (after !== undefined && before !== undefined) {
      throw this.error.validation();
    }

    return this.dialogs.history(req.user, id.toLowerCase(), this.limit(query.limit), after, before);
  }

  @Get(':dialog_id/messages/:message_id')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ operationId: 'dialogsMessageGet' })
  @ApiOkResponse({ type: MessageResponseDto })
  messageGet(
    @Req() req: Request,
    @Param('dialog_id', new ParseUUIDPipe()) id: string,
    @Param('message_id', new ParseUUIDPipe()) messageId: string,
  ): Promise<MessageResponseDto> {
    return this.dialogs.messageGet(req.user, id.toLowerCase(), messageId.toLowerCase());
  }

  @Patch(':dialog_id/messages/:message_id')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ operationId: 'dialogsMessageEdit' })
  @ApiOkResponse({ type: MessageResponseDto })
  @ApiResponse({ status: 409, type: ErrorResponseDto })
  @ApiResponse({ status: 413, type: ErrorResponseDto })
  edit(
    @Req() req: Request,
    @Param('dialog_id', new ParseUUIDPipe()) id: string,
    @Param('message_id', new ParseUUIDPipe()) messageId: string,
    @Body() input: EditMessageDto,
  ): Promise<MessageResponseDto> {
    const content = contentValue(input.content, this.error);

    if (content.kind !== 'text') {
      throw this.error.validation();
    }

    return this.dialogs.edit(req.user, id.toLowerCase(), messageId.toLowerCase(), {
      ...input,
      client_edit_id: input.client_edit_id.toLowerCase(),
      content,
    });
  }

  @Get(':dialog_id/message-edits')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ operationId: 'dialogsMessageEdits' })
  @ApiOkResponse({ type: MessageEditsResponseDto })
  @ApiQuery({
    name: 'after_edit_sequence',
    required: false,
    schema: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER, default: 0 },
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: 100, default: 30 },
  })
  edits(
    @Req() req: Request,
    @Param('dialog_id', new ParseUUIDPipe()) id: string,
    @Query() query: Record<string, unknown>,
  ): Promise<MessageEditsResponseDto> {
    if (
      Object.keys(query).some((key): boolean => !['after_edit_sequence', 'limit'].includes(key))
    ) {
      throw this.error.validation();
    }

    return this.dialogs.edits(
      req.user,
      id.toLowerCase(),
      queryInteger(query.after_edit_sequence, 'after_edit_sequence', 0, this.error)!,
      this.limit(query.limit),
    );
  }

  @Post(':dialog_id/read')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ operationId: 'dialogsRead' })
  read(
    @Req() req: Request,
    @Param('dialog_id', new ParseUUIDPipe()) id: string,
    @Body() input: ReadDialogDto,
  ): Promise<ReadResponseDto> {
    return this.dialogs.read(req.user, id.toLowerCase(), input.sequence);
  }

  private limit(value: unknown): number {
    return queryInteger(value, 'limit', 30, this.error, 1, 100)!;
  }
}
