import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { AuthGuard, type AuthIdentity } from '../auth/auth.guard.js';
import { ErrorResponseDto } from '../error/error.dto.js';
import { AdminGuard } from './admin.guard.js';
import {
  AdminCreateUserDto,
  AdminEmptyDto,
  AdminGroupsQueryDto,
  AdminGroupsResponseDto,
  AdminPasswordDto,
  AdminUserResponseDto,
  AdminUsersQueryDto,
  AdminUsersResponseDto,
} from './backoffice.dto.js';
import { BackofficeService } from './backoffice.service.js';

@ApiTags('Backoffice')
@ApiBearerAuth()
@UseGuards(AuthGuard, AdminGuard)
@ApiBadRequestResponse({ type: ErrorResponseDto })
@ApiUnauthorizedResponse({ type: ErrorResponseDto })
@ApiForbiddenResponse({ type: ErrorResponseDto })
@ApiNotFoundResponse({ type: ErrorResponseDto })
@ApiServiceUnavailableResponse({ type: ErrorResponseDto })
@Controller('admin')
export class BackofficeController {
  constructor(private readonly backoffice: BackofficeService) {}

  /** Найти аккаунты, включая отключённые и не состоящие в группах администратора. */
  @Get('users')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ operationId: 'adminListUsers' })
  list(@Query() query: AdminUsersQueryDto): Promise<AdminUsersResponseDto> {
    return this.backoffice.list(query);
  }

  /** Получить карточку аккаунта со всеми группами. */
  @Get('users/:user_id')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ operationId: 'adminGetUser' })
  get(@Param('user_id', new ParseUUIDPipe()) id: string): Promise<AdminUserResponseDto> {
    return this.backoffice.get(id.toLowerCase());
  }

  /** Подсказки существующих групп для создания аккаунта. */
  @Get('groups')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ operationId: 'adminListGroups' })
  groups(@Query() query: AdminGroupsQueryDto): Promise<AdminGroupsResponseDto> {
    return this.backoffice.listGroups(query);
  }

  /** Создать обычного пользователя с одной группой. Пароль не возвращается. */
  @Post('users')
  @Header('Cache-Control', 'no-store')
  @ApiConflictResponse({ description: 'LOGIN_TAKEN', type: ErrorResponseDto })
  @ApiOperation({ operationId: 'adminCreateUser' })
  create(
    @Req() request: { user: AuthIdentity },
    @Body() input: AdminCreateUserDto,
  ): Promise<AdminUserResponseDto> {
    return this.backoffice.create(request.user, input);
  }

  /** Сменить пароль и отозвать все сессии, сохраняя состояние отключения. */
  @Post('users/:user_id/password')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ operationId: 'adminChangeUserPassword' })
  password(
    @Req() request: { user: AuthIdentity },
    @Param('user_id', new ParseUUIDPipe()) id: string,
    @Body() input: AdminPasswordDto,
  ): Promise<AdminUserResponseDto> {
    return this.backoffice.change(request.user, id.toLowerCase(), 'password', input.password);
  }

  /** Отключить другой аккаунт и отозвать все сессии. */
  @Post('users/:user_id/disable')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ operationId: 'adminDisableUser' })
  disable(
    @Req() request: { user: AuthIdentity },
    @Param('user_id', new ParseUUIDPipe()) id: string,
    @Body() _input: AdminEmptyDto,
  ): Promise<AdminUserResponseDto> {
    return this.backoffice.change(request.user, id.toLowerCase(), 'disable');
  }

  /** Включить аккаунт, не восстанавливая прежние сессии. */
  @Post('users/:user_id/enable')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ operationId: 'adminEnableUser' })
  enable(
    @Req() request: { user: AuthIdentity },
    @Param('user_id', new ParseUUIDPipe()) id: string,
    @Body() _input: AdminEmptyDto,
  ): Promise<AdminUserResponseDto> {
    return this.backoffice.change(request.user, id.toLowerCase(), 'enable');
  }
}
