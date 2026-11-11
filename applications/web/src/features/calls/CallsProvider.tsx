import type { Dispatch, JSX, ReactNode, SetStateAction } from 'react';
import { createContext, useContext, useEffect, useState } from 'react';
import { useRouteLoaderData } from 'react-router';

import type { ApplicationLoaderData } from '../../app/loaders';
import { type Member, reasons } from '../../shared/calls/protocol';
import {
  type CallPresentationState,
  useDeviceCallSnapshot,
  useDevicePresentation,
} from '../../shared/device/react';
import { useAuth } from '../auth/AuthProvider';
import { CallScreenLock } from './CallScreenLock';
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
  lockScreen: () => void;
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
  const presentation = useDevicePresentation();
  const [person, setPerson] = useState<Member | null>(null);
  const contacts = useRouteLoaderData<ContactsData>('contacts');
  const [resolvedPeer, setResolvedPeer] = useState<{ id: string; name: string } | null>(null);
  const [now, setNow] = useState(Date.now());
  const [mobile, setMobile] = useState(false);
  const [locked, setLocked] = useState(false);

  useEffect(() => {
    setLocked(false);
  }, [state.call?.call_id, state.owner, state.selected, user?.sid]);

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
  let peerId: string | null = null;

  if (call) {
    peerId = call.caller_id === user?.sub ? call.recipient_id : call.caller_id;
  }

  const loadedName =
    contacts?.sid === user?.sid
      ? contacts?.members.find((member): boolean => member.id === peerId)?.display_name
      : undefined;

  useEffect((): (() => void) => {
    const controller = new AbortController();

    if (peerId && !loadedName && person?.id !== peerId) {
      void (async () => {
        try {
          const name = await resolvePeerName(device, peerId, controller.signal);

          if (!controller.signal.aborted && name) {
            setResolvedPeer({ id: peerId, name });
          }
        } catch (cause) {}
      })();
    }

    return (): void => controller.abort();
  }, [device, peerId, user?.sid, loadedName, person?.id]);
  let fallbackPeerName;

  if (person?.id === peerId) {
    fallbackPeerName = person.display_name;
  } else if (resolvedPeer?.id === peerId) {
    fallbackPeerName = resolvedPeer.name;
  } else {
    fallbackPeerName = 'Собеседник';
  }

  const peerName = peerId ? (loadedName ?? fallbackPeerName) : '';
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
  let callStatus;

  if (call?.state === 'ended') {
    callStatus = reasons[call.end_reason ?? ''] ?? 'Звонок завершён';
  } else if (call?.recovery_id) {
    callStatus = 'Восстанавливаем соединение…';
  } else if (call?.state === 'active') {
    callStatus = 'Разговор';
  } else if (call?.state === 'connecting') {
    callStatus = 'Соединяем…';
  } else if (incoming) {
    callStatus = 'Входящий звонок';
  } else {
    callStatus = 'Вызываем…';
  }

  const status = callStatus;
  const enabled =
    presentation.callingAvailable && state.owner && state.connection === 'online' && !state.busy;

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
    lockScreen: () => setLocked(true),
  };

  return (
    <CallsContext value={value}>
      {children}
      {locked && ongoing && state.owner && state.selected && presentation.callingAvailable && (
        <CallScreenLock unlock={() => setLocked(false)} />
      )}
    </CallsContext>
  );
}

export function useCalls(): CallsRuntime {
  const value = useContext(CallsContext);

  if (!value) {
    throw new Error('CallsProvider is required');
  }

  return value;
}
