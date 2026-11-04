import type { GroupMembersResponseDto, GroupsResponseDto } from '@gchat/backend-api';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { Dispatch, JSX, ReactNode, SetStateAction } from 'react';
import { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react';

import { useAuth } from '../auth/AuthProvider';
import { request } from '../auth/session';
import { type ClientState, GChatClient } from './client';
import { type Member, reasons } from './protocol';

type Setter<T> = Dispatch<SetStateAction<T>>;
interface CallsRuntime {
  client: GChatClient;
  state: ClientState;
  groups: UseQueryResult<GroupsResponseDto>;
  members: UseQueryResult<GroupMembersResponseDto>;
  groupId: string | null;
  setGroupId: Setter<string | null>;
  person: Member | null;
  setPerson: Setter<Member | null>;
  mobile: boolean;
  setMobile: Setter<boolean>;
  call: ClientState['call'];
  incoming: boolean;
  ongoing: boolean;
  peerId: string | null;
  peerName: string;
  status: string;
  duration: string;
  enabled: boolean;
  selectedGroup: GroupsResponseDto['groups'][number] | undefined;
  currentMembers: Member[];
}
const client = new GChatClient();
const CallsContext = createContext<CallsRuntime | null>(null);

export function CallsProvider({ children }: { children: ReactNode }): JSX.Element {
  const { user } = useAuth();
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const [groupId, setGroupId] = useState<string | null>(null);
  const [person, setPerson] = useState<Member | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [now, setNow] = useState(Date.now());
  const [mobile, setMobile] = useState(false);
  const groups = useQuery({
    queryKey: ['groups', user?.sub],
    queryFn: async ({ signal }): Promise<GroupsResponseDto> =>
      request((api): ReturnType<typeof api.groupsList> => api.groupsList({ signal })),
    enabled: !!user,
    retry: 1,
    refetchOnWindowFocus: true,
    refetchInterval: 60000,
  });
  const members = useQuery({
    queryKey: ['members', user?.sub, groupId],
    queryFn: async ({ signal }): Promise<GroupMembersResponseDto> => {
      if (!groupId) return { members: [] };

      return request((api): ReturnType<typeof api.groupsListMembers> =>
        api.groupsListMembers({ path: { group_id: groupId }, signal }),
      );
    },
    enabled: !!user && !!groupId,
    retry: 1,
    refetchOnWindowFocus: true,
    refetchInterval: 60000,
  });

  useEffect((): (() => void) => client.start(), []);
  useEffect((): void => {
    setGroupId(null);
    setPerson(null);
    setNames({});
    setMobile(false);
  }, [user?.sid]);
  useEffect((): void => {
    if (groups.data?.groups.length && !groups.data.groups.some((g): boolean => g.id === groupId))
      setGroupId(groups.data.groups[0].id);
  }, [groups.data, groupId]);
  useEffect((): void => {
    if (members.data)
      setNames((previous): Record<string, string> => ({
        ...previous,
        ...Object.fromEntries(
          members.data.members.map((member): [string, string] => [member.id, member.display_name]),
        ),
      }));
  }, [members.data]);
  useEffect((): (() => void) => {
    const timer = setInterval((): void => setNow(Date.now()), 1000);

    return (): void => clearInterval(timer);
  }, []);
  useEffect((): void => {
    if (state.call && state.call.state !== 'ended') {
      setMobile(true);
    }
  }, [state.call?.call_id, state.call?.state, user?.sub]);
  // Resolve names in other groups as well, without expanding backend read permissions.
  useEffect((): (() => void) => {
    let cancelled = false;

    if (groups.data)
      void Promise.all(
        groups.data.groups.map(async (group): Promise<void> => {
          try {
            const data = await request((api): ReturnType<typeof api.groupsListMembers> =>
              api.groupsListMembers({ path: { group_id: group.id } }),
            );

            if (!cancelled)
              setNames((old): Record<string, string> => ({
                ...old,
                ...Object.fromEntries(
                  data.members.map((m): [string, string] => [m.id, m.display_name]),
                ),
              }));
          } catch {
            /* Selected group displays its own loading error. */
          }
        }),
      );

    return (): void => {
      cancelled = true;
    };
  }, [groups.data]);

  const call = state.call;
  const incoming = !!call && call.recipient_id === user?.sub && call.state === 'ringing';
  const peerId = call ? (call.caller_id === user?.sub ? call.recipient_id : call.caller_id) : null;
  const peerName = peerId
    ? (names[peerId] ?? (person?.id === peerId ? person.display_name : 'Собеседник'))
    : '';
  const selectedGroup = groups.data?.groups.find((group): boolean => group.id === groupId);
  const currentMembers =
    members.data?.members.filter((member): boolean => member.id !== user?.sub) ?? [];
  const ongoing = !!call && call.state !== 'ended';
  const seconds = call?.started_at
    ? Math.max(
        0,
        Math.floor(
          ((call.ended_at ? Date.parse(call.ended_at) : now) - Date.parse(call.started_at)) / 1000,
        ),
      )
    : 0;
  const duration =
    String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0');
  const status =
    call?.state === 'ended'
      ? (reasons[call.end_reason ?? ''] ?? 'Звонок завершён')
      : call?.recovery_id
        ? 'Восстанавливаем соединение…'
        : call?.state === 'active'
          ? 'Разговор'
          : call?.state === 'connecting'
            ? 'Соединяем…'
            : incoming
              ? 'Входящий звонок'
              : 'Вызываем…';
  const enabled = state.owner && state.connection === 'online' && !state.busy;

  const value: CallsRuntime = {
    client,
    state,
    groups,
    members,
    groupId,
    setGroupId,
    person,
    setPerson,
    mobile,
    setMobile,
    call,
    incoming,
    ongoing,
    peerId,
    peerName,
    status,
    duration,
    enabled,
    selectedGroup,
    currentMembers,
  };

  return <CallsContext value={value}>{children}</CallsContext>;
}

export function useCalls(): CallsRuntime {
  const value = useContext(CallsContext);

  if (!value) throw new Error('CallsProvider is required');

  return value;
}
