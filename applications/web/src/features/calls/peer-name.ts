import type { BackendApi, GroupMembersResponseDto } from '@gchat/backend-api';

import type { ApplicationDevice } from '../../app/device';
import type { Member } from '../../shared/calls/protocol';

export async function resolvePeerName(
  device: ApplicationDevice,
  peer: string,
  signal: AbortSignal,
): Promise<string | null> {
  const groups = (
    await device.session.run(
      (api, combined): ReturnType<BackendApi['groupsList']> => api.groupsList({ signal: combined }),
      { signal },
    )
  ).data;
  const pages = await Promise.all(
    groups.groups.map(
      async (group): Promise<GroupMembersResponseDto> =>
        (
          await device.session.run(
            (api, combined): ReturnType<BackendApi['groupsListMembers']> =>
              api.groupsListMembers({ path: { group_id: group.id }, signal: combined }),
            { signal },
          )
        ).data,
    ),
  );

  return (
    pages.flatMap((page): Member[] => page.members).find((member): boolean => member.id === peer)
      ?.display_name ?? null
  );
}
