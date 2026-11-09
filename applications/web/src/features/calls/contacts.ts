import type { BackendApi } from '@gchat/backend-api';
import type { GroupMembersResponseDto, GroupsResponseDto } from '@gchat/backend-api';
import type { LoaderFunctionArgs } from 'react-router';

import { applicationDevice, userContext } from '../../app/router-context';
import type { Member } from '../../shared/calls/protocol';
import { readQuery } from '../../shared/validation/request';
import { contactsQuerySchema } from './request-schemas';

export interface ContactsData {
  sid: string | null;
  groups: GroupsResponseDto['groups'];
  members: Member[];
  groupId: string | null;
  error: string | null;
}

export async function contactsLoader({
  request: input,
  context,
}: LoaderFunctionArgs): Promise<ContactsData> {
  const device = applicationDevice(context);
  const user = context.get(userContext);
  const { group: selected } = readQuery(contactsQuerySchema, input);

  try {
    const { data: runResultData } = await device.session.run(
      (api, signal): ReturnType<BackendApi['groupsList']> => api.groupsList({ signal }),
      { signal: input.signal },
    );
    const groups = runResultData.groups;
    let groupIdValue;

    if (selected && selected !== 'all') {
      groupIdValue = selected;
    } else if (user.role === 'admin') {
      groupIdValue = null;
    } else {
      groupIdValue = groups[0]?.id ?? null;
    }

    const groupId = groupIdValue;
    let members: GroupMembersResponseDto['members'] = [];

    if (groupId) {
      const { data: runResultData2 } = await device.session.run(
        (api, signal): ReturnType<BackendApi['groupsListMembers']> =>
          api.groupsListMembers({ path: { group_id: groupId }, signal }),
        { signal: input.signal },
      );

      members = runResultData2.members;
    } else if (user.role === 'admin') {
      let offset = 0;

      while (true) {
        const page = await device.session.run(
          (api, signal): ReturnType<BackendApi['adminListUsers']> =>
            api.adminListUsers({
              query: { status: 'active', limit: 100, offset },
              signal,
            }),
          { signal: input.signal },
        );

        const { data: pageData } = page;

        members.push(
          ...pageData.users.map(({ id, display_name }): Member => ({ id, display_name })),
        );
        const { data: pageData2 } = page;

        offset += pageData2.users.length;

        const { data: pageData3 } = page ?? {};

        if (!pageData3.users.length || offset >= pageData3.total) {
          break;
        }
      }
    }

    return {
      sid: user.sid,
      groups,
      members: [
        ...new Map(members.map((member): [string, Member] => [member.id, member])).values(),
      ],
      groupId,
      error: null,
    };
  } catch {
    input.signal.throwIfAborted();

    return {
      sid: user.sid,
      groups: [],
      members: [],
      groupId: null,
      error: 'Не удалось загрузить контакты',
    };
  }
}
