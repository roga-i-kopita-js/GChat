import { Body, Controller, Header, HttpCode, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiNoContentResponse,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { ErrorResponseDto } from '../error/error.dto.js';
import { LoginDto, RefreshDto, RefreshTokenDto, TokensDto } from './auth.dto.js';
import { AuthService } from './auth.service.js';

@ApiTags('Auth')
@ApiBadRequestResponse({ description: 'VALIDATION_ERROR', type: ErrorResponseDto })
@ApiServiceUnavailableResponse({ description: 'SERVICE_UNAVAILABLE', type: ErrorResponseDto })
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** Войти и создать независимую сессию. */
  @Post('login')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiUnauthorizedResponse({ description: 'INVALID_CREDENTIALS', type: ErrorResponseDto })
  @ApiTooManyRequestsResponse({
    description: 'RATE_LIMITED; Retry-After содержит задержку в секундах',
    type: ErrorResponseDto,
  })
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
  refresh(@Body() input: RefreshDto): Promise<TokensDto> {
    return this.auth.refresh(input);
  }

  /** Отозвать только указанную сессию. Неизвестный токен также получает 204. */
  @Post('logout')
  @HttpCode(204)
  @Header('Cache-Control', 'no-store')
  @ApiNoContentResponse({ description: 'Выход завершён' })
  logout(@Body() input: RefreshTokenDto): Promise<void> {
    return this.auth.logout(input.refresh_token);
  }
}
