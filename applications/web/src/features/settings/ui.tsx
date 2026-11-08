import './settings.css';

import { ArrowLeft, ChevronRight, LoaderCircle, type LucideIcon } from 'lucide-react';
import type { CSSProperties, JSX, ReactNode } from 'react';
import { Link } from 'react-router';

import { deviceErrorMessage } from '../../shared/device/messages';
import type { SettingsDevice } from './useSettingsDevice';

function Badge({ icon: Icon, color }: { icon: LucideIcon; color: string }): JSX.Element {
  const style: CSSProperties = { backgroundColor: color };

  return (
    <span className="settings-icon" style={style}>
      <Icon size={19} aria-hidden="true" />
    </span>
  );
}

export function Row({
  icon,
  color,
  title,
  value,
  to,
  children,
}: {
  icon: LucideIcon;
  color: string;
  title: string;
  value?: string;
  to?: string;
  children?: ReactNode;
}): JSX.Element {
  const body = (
    <>
      <Badge icon={icon} color={color} />
      <span className="settings-row-copy">
        <span>{title}</span>
        {children}
      </span>
      {value && <span className="settings-value">{value}</span>}
      {to && <ChevronRight className="settings-chevron" size={17} aria-hidden="true" />}
    </>
  );

  return to ? (
    <Link className="settings-row" to={to}>
      {body}
    </Link>
  ) : (
    <div className="settings-row">{body}</div>
  );
}

export function Group({ title, children }: { title?: string; children: ReactNode }): JSX.Element {
  return (
    <section className="settings-group">
      {title && <h2>{title}</h2>}
      <div className="settings-surface">{children}</div>
    </section>
  );
}

export function SettingsScreen({
  title,
  parent,
  device,
  children,
}: {
  title: string;
  parent?: string;
  device?: SettingsDevice;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className="settings-page" aria-label={title}>
      <div className="settings-heading">
        {parent && (
          <Link to={parent} aria-label="Назад" className="settings-back">
            <ArrowLeft size={21} />
          </Link>
        )}
        <h1>{title}</h1>
      </div>
      {children}
      {device?.error && (
        <div className="settings-error" role="alert">
          <p>{device.error}</p>
          <button
            disabled={device.busy}
            onClick={(): void => {
              device.setError('');
              void device
                .refresh()
                .catch((cause: unknown): void => device.setError(deviceErrorMessage(cause)));
            }}
          >
            Обновить состояние
          </button>
        </div>
      )}
    </section>
  );
}

export function SettingsAction({
  device,
  children,
  onClick,
}: {
  device: SettingsDevice;
  children: ReactNode;
  onClick(): void;
}): JSX.Element {
  return (
    <button className="settings-action" disabled={device.busy} onClick={onClick}>
      {children}
      {device.busy && <LoaderCircle className="settings-spinner" size={16} aria-hidden="true" />}
    </button>
  );
}
