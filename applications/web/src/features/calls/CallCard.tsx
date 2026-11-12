import {
  ArrowRight,
  LockKeyhole,
  Mic,
  MicOff,
  Phone,
  PhoneOff,
  ShieldCheck,
  Volume2,
} from 'lucide-react';
import type { JSX } from 'react';
import { useLocation, useNavigate } from 'react-router';

import { useDevice, useDevicePresentation } from '../../shared/device/react';
import { Avatar, Button } from '../../shared/ui';
import { CallAudioOutput } from './CallAudioOutput';
import { useCalls } from './CallsProvider';

export function CallCard(): JSX.Element | null {
  const device = useDevice();
  const navigate = useNavigate();
  const location = useLocation();
  const presentation = useDevicePresentation();
  const {
    state,
    call,
    incoming,
    peerName,
    duration,
    status,
    enabled,
    setPerson,
    setMobile,
    lockScreen,
  } = useCalls();

  if (!call) {
    return null;
  }

  let callActions;

  if (call.state === 'ended') {
    callActions = (
      <button
        className="secondary"
        onClick={(): void => {
          setPerson(null);
          setMobile(false);
          const filter = new URLSearchParams(location.search).get('filter');

          void navigate('/calls' + (filter === 'missed' ? '?filter=missed' : ''));
          void (async () => {
            try {
              return await device.calls.dismissEnded();
            } catch (cause) {}
          })();
        }}
      >
        Вернуться к истории
        <ArrowRight size={17} />
      </button>
    );
  } else if (incoming) {
    callActions = (
      <>
        <button
          className="round-action decline"
          disabled={!enabled}
          onClick={(): void => {
            void (async () => {
              try {
                return await device.calls.end();
              } catch (cause) {}
            })();
          }}
        >
          <span>
            <PhoneOff size={25} />
          </span>
          Отклонить
        </button>
        <button
          className="round-action accept"
          disabled={!enabled}
          onClick={(): void => {
            void (async () => {
              try {
                return await device.calls.accept();
              } catch (cause) {}
            })();
          }}
        >
          <span>
            <Phone size={25} />
          </span>
          Принять
        </button>
      </>
    );
  } else if (state.selected) {
    callActions = (
      <>
        {state.owner && <CallAudioOutput key={call.call_id} disabled={state.busy} />}
        {call.state !== 'ringing' && (
          <button
            className={'round-action mute' + (state.muted ? ' muted' : '')}
            aria-pressed={state.muted}
            disabled={!enabled}
            onClick={(): void =>
              void (async () => {
                try {
                  return await device.calls.setMuted(!state.muted);
                } catch (cause) {}
              })()
            }
          >
            <span>{state.muted ? <MicOff size={25} /> : <Mic size={25} />}</span>
            {state.muted ? 'Включить микрофон' : 'Микрофон'}
          </button>
        )}
        <button
          className="round-action decline"
          disabled={!enabled}
          onClick={(): void => {
            void (async () => {
              try {
                return await device.calls.end();
              } catch (cause) {}
            })();
          }}
        >
          <span>
            <PhoneOff size={25} />
          </span>
          {call.state === 'ringing' ? 'Отменить' : 'Завершить'}
        </button>
      </>
    );
  } else {
    callActions = null;
  }

  return (
    <div className={'call-card ' + (call.state === 'ended' ? 'ended' : '')}>
      <div className="call-card-header">
        <div className="call-brand">
          <Phone size={16} /> GChat · голосовой звонок
        </div>
        {state.owner &&
          state.selected &&
          call.state !== 'ended' &&
          presentation.callingAvailable && (
            <Button variant="ghost" className="call-lock-button" onClick={lockScreen}>
              <LockKeyhole aria-hidden="true" /> Заблокировать
            </Button>
          )}
      </div>
      <div className="call-person">
        <Avatar name={peerName} large />
        <h2>{peerName}</h2>
        <p role="status" data-testid="call-status">
          {status}
        </p>
        {call.started_at && (
          <div className="duration" data-testid="duration">
            {duration}
          </div>
        )}
        {call.state === 'active' && !call.recovery_id && (
          <div className="sound-wave" aria-hidden="true">
            {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((id): JSX.Element => (
              <i key={id} style={{ animationDelay: (id % 4) * 0.15 + 's' }} />
            ))}
          </div>
        )}
      </div>
      {!state.selected && call.state !== 'ringing' && call.state !== 'ended' && (
        <p className="call-hint">Разговор открыт на другом устройстве.</p>
      )}
      {state.audioBlocked && (
        <button
          className="secondary"
          onClick={(): void => {
            void (async () => {
              try {
                return await device.calls.activateAudio();
              } catch (cause) {}
            })();
          }}
        >
          <Volume2 size={18} /> Включить звук
        </button>
      )}
      {incoming && state.error && <p role="alert">{state.error}</p>}
      {!presentation.callingAvailable && (
        <p className="call-hint">
          Управление звонками недоступно. Обновите приложение для продолжения.
        </p>
      )}
      {state.owner && state.selected && call.state !== 'ended' && state.screenWakeLockWarning && (
        <p className="call-hint" role="status">
          Не удалось удержать экран включённым. Отключите автоблокировку в настройках устройства на
          время звонка.
        </p>
      )}
      <div className="call-controls">{callActions}</div>
      <div className="call-bottom">
        <ShieldCheck size={14} />
        <span>Аудио передаётся в зашифрованном виде</span>
      </div>
    </div>
  );
}
