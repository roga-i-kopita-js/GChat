import { Body, Controller, Header, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { ErrorResponseDto } from '../error/error.dto.js';
import {
  LoginDto,
  RefreshDto,
  RefreshTokenDto,
  TokensDto,
  WsTicketRequestDto,
  WsTicketResponseDto,
} from './auth.dto.js';
import type { AuthIdentity } from './auth.guard.js';
import { AuthGuard } from './auth.guard.js';
import { AuthService } from './auth.service.js';
import { AuthWsTickets } from './auth.ws-tickets.js';

@ApiTags('Auth')
@ApiBadRequestResponse({ description: 'VALIDATION_ERROR', type: ErrorResponseDto })
@ApiServiceUnavailableResponse({ description: 'SERVICE_UNAVAILABLE', type: ErrorResponseDto })
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly tickets: AuthWsTickets,
  ) {}

  /** Получить одноразовый билет браузерного WebSocket; действует 30 секунд. */
  @Post('ws-ticket')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @Header('Cache-Control', 'no-store')
  @ApiUnauthorizedResponse({
    description: 'ACCESS_TOKEN_EXPIRED / ACCESS_TOKEN_INVALID / SESSION_INVALID',
    type: ErrorResponseDto,
  })
  @ApiForbiddenResponse({ description: 'Origin не разрешён', type: ErrorResponseDto })
  @ApiTooManyRequestsResponse({ description: 'RATE_LIMITED', type: ErrorResponseDto })
  @ApiOperation({ operationId: 'authWsTicket' })
  wsTicket(
    @Body() _input: WsTicketRequestDto,
    @Req() request: { user: AuthIdentity; headers: { origin?: string } },
  ): Promise<WsTicketResponseDto> {
    return this.tickets.issue(request.user, request.headers.origin);
  }

  /** Войти и создать независимую сессию. */
  @Post('login')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiUnauthorizedResponse({ description: 'INVALID_CREDENTIALS', type: ErrorResponseDto })
  @ApiTooManyRequestsResponse({
    description: 'RATE_LIMITED; Retry-After содержит задержку в секундах',
    type: ErrorResponseDto,
  })
  @ApiOperation({ operationId: 'authLogin' })
  login(@Body() input: LoginDto): Promise<TokensDto> {
    return this.auth.login(input);
  }

  /** Обновить токены; повтор использует прежние refresh_token и request_id. */
  @Post('refresh')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiUnauthorizedResponse({ description: 'SESSION_INVALID', type: ErrorResponseDto })
  @ApiTooManyRequestsResponse({
    description: 'RATE_LIMITED; Retry-After содержит задержку в секундах',
    type: ErrorResponseDto,
  })
  @ApiOperation({ operationId: 'authRefresh' })
  refresh(@Body() input: RefreshDto): Promise<TokensDto> {
    return this.auth.refresh(input);
  }

  /** Отозвать только указанную сессию. Неизвестный токен также получает 204. */
  @Post('logout')
  @HttpCode(204)
  @Header('Cache-Control', 'no-store')
  @ApiNoContentResponse({ description: 'Выход завершён' })
  @ApiOperation({ operationId: 'authLogout' })
  logout(@Body() input: RefreshTokenDto): Promise<void> {
    return this.auth.logout(input.refresh_token);
  }
}
