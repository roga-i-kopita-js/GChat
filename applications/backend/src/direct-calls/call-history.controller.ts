import { Controller, Get, Header, Param, Query, Req, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiInternalServerErrorResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { AuthGuard, type AuthIdentity } from '../auth/auth.guard.js';
import { ErrorResponseDto } from '../error/error.dto.js';
import {
  CallHistoryListResponseDto,
  CallHistoryParamsDto,
  CallHistoryQueryDto,
  CallHistoryResponseDto,
} from './call-history.dto.js';
import { CallHistoryService } from './call-history.service.js';

@ApiTags('Calls')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@ApiBadRequestResponse({ type: ErrorResponseDto })
@ApiUnauthorizedResponse({ type: ErrorResponseDto })
@ApiForbiddenResponse({ type: ErrorResponseDto })
@ApiTooManyRequestsResponse({
  type: ErrorResponseDto,
  headers: { 'Retry-After': { schema: { type: 'integer' } } },
})
@ApiServiceUnavailableResponse({ type: ErrorResponseDto })
@ApiInternalServerErrorResponse({ type: ErrorResponseDto })
@Controller('calls/history')
export class CallHistoryController {
  constructor(private readonly history: CallHistoryService) {}

  /** Own completed calls, newest first; durable across technical call cleanup. */
  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ operationId: 'callsHistoryList' })
  @ApiQuery({
    name: 'filter',
    required: false,
    enum: ['all', 'missed'],
    schema: { default: 'all' },
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    schema: { type: 'integer', minimum: 1, maximum: 100, default: 30 },
  })
  @ApiQuery({
    name: 'cursor',
    required: false,
    type: String,
    schema: { type: 'string', minLength: 1, maxLength: 2048 },
  })
  @ApiOkResponse({ type: CallHistoryListResponseDto })
  list(
    @Req() req: { user: AuthIdentity },
    @Query() query: CallHistoryQueryDto,
  ): Promise<CallHistoryListResponseDto> {
    return this.history.list(req.user, query);
  }

  /** Durable metadata of one of the actor's completed calls. */
  @Get(':call_id')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ operationId: 'callsHistoryGet' })
  @ApiOkResponse({ type: CallHistoryResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  get(
    @Req() req: { user: AuthIdentity },
    @Param() params: CallHistoryParamsDto,
  ): Promise<CallHistoryResponseDto> {
    return this.history.get(req.user, params.call_id);
  }
}
