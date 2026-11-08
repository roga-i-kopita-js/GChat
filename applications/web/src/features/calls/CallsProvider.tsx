import type { Dispatch, JSX, ReactNode, SetStateAction } from 'react';
import { createContext, useContext, useEffect, useState } from 'react';
import { useRouteLoaderData } from 'react-router';

import type { ApplicationLoaderData } from '../../app/loaders';
import { type Member, reasons } from '../../shared/calls/protocol';
import { type CallPresentationState, useDeviceCallSnapshot } from '../../shared/device/react';
import { useAuth } from '../auth/AuthProvider';
import type { ContactsData } from './contacts';
import { resolvePeerName } from './peer-name';

type Setter<T> = Dispatch<SetStateAction<T>>;
interface CallsRuntime {
  state: CallPresentationState;
  person: Member | null;
  setPerson: Setter<Member | null>;
  mobile: boolean;
  setMobile: Setter<boolean>;
  call: CallPresentationState['call'];
  incoming: boolean;
  ongoing: boolean;
  peerId: string | null;
  peerName: string;
  status: string;
  duration: string;
  enabled: boolean;
}

const CallsContext = createContext<CallsRuntime | null>(null);

export function CallsProvider({ children }: { children: ReactNode }): JSX.Element {
  const root = useRouteLoaderData<ApplicationLoaderData>('application');

  if (!root) {
    throw new Error('Application loader is required');
  }

  const { device } = root;
  const { user } = useAuth();
  const state = useDeviceCallSnapshot();
  const [person, setPerson] = useState<Member | null>(null);
  const contacts = useRouteLoaderData<ContactsData>('contacts');
  const [resolvedPeer, setResolvedPeer] = useState<{ id: string; name: string } | null>(null);
  const [now, setNow] = useState(Date.now());
  const [mobile, setMobile] = useState(false);

  useEffect((): void => {
    setPerson(null);
    setResolvedPeer(null);
    setMobile(false);
  }, [user?.sid]);
  useEffect((): (() => void) => {
    const timer = setInterval((): void => setNow(Date.now()), 1000);

    return (): void => clearInterval(timer);
  }, []);
  useEffect((): void => {
    if (state.call && state.call.state !== 'ended') {
      setMobile(true);
    }
  }, [state.call?.call_id, state.call?.state, user?.sub]);
  const call = state.call;
  const incoming = !!call && call.recipient_id === user?.sub && call.state === 'ringing';
  const peerId = call ? (call.caller_id === user?.sub ? call.recipient_id : call.caller_id) : null;
  const loadedName =
    contacts?.sid === user?.sid
      ? contacts?.members.find((member): boolean => member.id === peerId)?.display_name
      : undefined;

  useEffect((): (() => void) => {
    const controller = new AbortController();

    if (peerId && !loadedName && person?.id !== peerId) {
      void resolvePeerName(device, peerId, controller.signal)
        .then((name): void => {
          if (!controller.signal.aborted && name) {
            setResolvedPeer({ id: peerId, name });
          }
        })
        .catch((): void => {});
    }

    return (): void => controller.abort();
  }, [device, peerId, user?.sid, loadedName, person?.id]);
  const peerName = peerId
    ? (loadedName ??
      (person?.id === peerId
        ? person.display_name
        : resolvedPeer?.id === peerId
          ? resolvedPeer.name
          : 'Собеседник'))
    : '';
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
    state,
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
  };

  return <CallsContext value={value}>{children}</CallsContext>;
}

export function useCalls(): CallsRuntime {
  const value = useContext(CallsContext);

  if (!value) {
    throw new Error('CallsProvider is required');
  }

  return value;
}
