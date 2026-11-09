import { Code2 } from 'lucide-react';
import type { JSX } from 'react';

import { useLayoutOverlays } from '../../shared/device/LayoutOverlaysProvider';
import { useLayout } from './LayoutProvider';

export function DiagnosticsTrigger(): JSX.Element | null {
  const { callNotices } = useLayout();
  const { diagnosticsAvailable, openDiagnostics } = useLayoutOverlays();

  return callNotices && diagnosticsAvailable ? (
    <footer className="workspace-footer">
      <button onClick={openDiagnostics}>
        <Code2 size={14} /> Диагностика
      </button>
    </footer>
  ) : null;
}
