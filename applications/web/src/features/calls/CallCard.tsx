import { ArrowRight, Mic, MicOff, Phone, PhoneOff, ShieldCheck, Volume2 } from 'lucide-react';
import type { JSX } from 'react';

import { useDevice, useDevicePresentation } from '../../shared/device/react';
import { Avatar } from '../../shared/ui';
import { useCalls } from './CallsProvider';

export function CallCard(): JSX.Element | null {
  const device = useDevice();
  const presentation = useDevicePresentation();
  const { state, call, incoming, peerName, duration, status, enabled, setPerson, setMobile } =
    useCalls();

  if (!call) {
    return null;
  }

  return (
    <div className={'call-card ' + (call.state === 'ended' ? 'ended' : '')}>
      <div className="call-brand">
        <Phone size={16} /> GChat · голосовой звонок
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
            void device.calls.activateAudio().catch((): void => {});
          }}
        >
          <Volume2 size={18} /> Включить звук
        </button>
      )}
      {incoming && state.error && <p role="alert">{state.error}</p>}
      {presentation.callControls === 'host' && call.state !== 'ended' && (
        <p className="call-hint">Управление звонком доступно в приложении.</p>
      )}
      <div className="call-controls">
        {call.state === 'ended' ? (
          <button
            className="secondary"
            onClick={(): void => {
              setPerson(null);
              setMobile(false);
              void device.calls.dismissEnded().catch((): void => {});
            }}
          >
            Вернуться к контактам
            <ArrowRight size={17} />
          </button>
        ) : presentation.callControls === 'host' ? null : incoming ? (
          <>
            <button
              className="round-action decline"
              disabled={!enabled}
              onClick={(): void => {
                void device.calls.end().catch((): void => {});
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
                void device.calls.accept().catch((): void => {});
              }}
            >
              <span>
                <Phone size={25} />
              </span>
              Принять
            </button>
          </>
        ) : state.selected ? (
          <>
            {call.state !== 'ringing' && (
              <button
                className={'round-action mute' + (state.muted ? ' muted' : '')}
                aria-pressed={state.muted}
                disabled={!state.owner}
                onClick={(): void => void device.calls.setMuted(!state.muted).catch((): void => {})}
              >
                <span>{state.muted ? <MicOff size={25} /> : <Mic size={25} />}</span>
                {state.muted ? 'Включить микрофон' : 'Микрофон'}
              </button>
            )}
            <button
              className="round-action decline"
              disabled={!enabled}
              onClick={(): void => {
                void device.calls.end().catch((): void => {});
              }}
            >
              <span>
                <PhoneOff size={25} />
              </span>
              {call.state === 'ringing' ? 'Отменить' : 'Завершить'}
            </button>
          </>
        ) : null}
      </div>
      <div className="call-bottom">
        <ShieldCheck size={14} />
        <span>Аудио передаётся в зашифрованном виде</span>
      </div>
    </div>
  );
}
