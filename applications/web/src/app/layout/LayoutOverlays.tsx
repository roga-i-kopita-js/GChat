import type { JSX } from 'react';
import { lazy } from 'react';

import { useLayoutOverlays } from '../../shared/device/LayoutOverlaysProvider';
import { LazyPanel } from '../../shared/ui/LazyPanel';

const DiagnosticsDialog = lazy(
  async (): Promise<{
    default: typeof import('../../features/calls/DiagnosticsDialog').DiagnosticsDialog;
  }> => {
    const { DiagnosticsDialog: resultDiagnosticsDialog } =
      await import('../../features/calls/DiagnosticsDialog');

    return {
      default: resultDiagnosticsDialog,
    };
  },
);

export function LayoutOverlays(): JSX.Element | null {
  const { diagnostics, closeDiagnostics } = useLayoutOverlays();

  return diagnostics ? (
    <LazyPanel
      pending={<p role="status">Загружаем диагностику…</p>}
      failed={
        <div role="alert">
          <p>Не удалось загрузить диагностику.</p>
          <button onClick={closeDiagnostics}>Закрыть диагностику</button>
        </div>
      }
    >
      <DiagnosticsDialog close={closeDiagnostics} />
    </LazyPanel>
  ) : null;
}
