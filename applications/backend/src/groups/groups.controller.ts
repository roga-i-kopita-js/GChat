import { Controller, Get, Header, Param, ParseUUIDPipe, Req, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import type { AuthIdentity } from '../auth/auth.guard.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { ErrorResponseDto } from '../error/error.dto.js';
import { GroupMembersResponseDto, GroupsResponseDto } from './groups.dto.js';
import { GroupsService } from './groups.service.js';

@ApiTags('Groups')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@ApiUnauthorizedResponse({ type: ErrorResponseDto })
@ApiServiceUnavailableResponse({ type: ErrorResponseDto })
@Controller('groups')
export class GroupsController {
  constructor(private readonly groups: GroupsService) {}

  /** Получить группы текущего пользователя. */
  @Get()
  @Header('Cache-Control', 'no-store')
  async list(@Req() request: { user: AuthIdentity }): Promise<GroupsResponseDto> {
    return { groups: await this.groups.list(request.user.userId) };
  }

  /** Получить активных участников своей группы. */
  @Get(':group_id/members')
  @Header('Cache-Control', 'no-store')
  @ApiNotFoundResponse({
    description: 'Группа недоступна или не существует',
    type: ErrorResponseDto,
  })
  async members(
    @Req() request: { user: AuthIdentity },
    @Param('group_id', new ParseUUIDPipe()) id: string,
  ): Promise<GroupMembersResponseDto> {
    return { members: await this.groups.members(request.user.userId, id) };
  }
}
