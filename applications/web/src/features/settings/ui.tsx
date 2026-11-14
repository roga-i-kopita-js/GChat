import './settings.css';

import { ArrowLeft, ChevronRight, LoaderCircle, type LucideIcon } from 'lucide-react';
import type { JSX, ReactNode } from 'react';
import { Link } from 'react-router';

import { deviceErrorMessage } from '../../shared/device/messages';
import { Button, Card, ContentColumn, PageHeader, Text } from '../../shared/ui';
import type { SettingsDevice } from './useSettingsDevice';

function Badge({ icon: Icon }: { icon: LucideIcon }): JSX.Element {
  return (
    <span className="settings-icon">
      <Icon size={19} aria-hidden="true" />
    </span>
  );
}

export function Row({
  icon,
  title,
  value,
  to,
  children,
}: {
  icon: LucideIcon;
  title: string;
  value?: string;
  to?: string;
  children?: ReactNode;
}): JSX.Element {
  const body = (
    <>
      <Badge icon={icon} />
      <span className="settings-row-copy">
        <Text variant="label">{title}</Text>
        {children}
      </span>
      {value && (
        <Text tone="muted" className="settings-value">
          {value}
        </Text>
      )}
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
      {title && (
        <Text as="h2" variant="caption" tone="muted">
          {title}
        </Text>
      )}
      <Card padding="none" bordered={false} clip className="settings-surface">
        {children}
      </Card>
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
      {!parent && (
        <PageHeader variant="section">
          <h1>{title}</h1>
        </PageHeader>
      )}
      <ContentColumn>
        {parent && (
          <Link className="settings-back" to={parent} aria-label="Назад">
            <ArrowLeft size="var(--ui-icon-small)" aria-hidden="true" />
            Назад
          </Link>
        )}
        {children}
        {device?.error && (
          <div className="settings-error" role="alert">
            <Text as="p" tone="danger">
              {device.error}
            </Text>
            <Button
              variant="ghost"
              disabled={device.busy}
              onClick={(): void => {
                device.setError('');
                void (async () => {
                  try {
                    return await device.refresh();
                  } catch (cause) {
                    return device.setError(deviceErrorMessage(cause));
                  }
                })();
              }}
            >
              Обновить состояние
            </Button>
          </div>
        )}
      </ContentColumn>
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
    <Button variant="ghost" className="settings-action" disabled={device.busy} onClick={onClick}>
      {children}
      {device.busy && <LoaderCircle className="settings-spinner" size={16} aria-hidden="true" />}
    </Button>
  );
}
