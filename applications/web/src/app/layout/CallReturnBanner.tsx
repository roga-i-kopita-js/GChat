import { Phone } from 'lucide-react';
import type { JSX } from 'react';
import { Link } from 'react-router';

import { useCalls } from '../../features/calls/CallsProvider';
import { useLayout } from './LayoutProvider';

export function CallReturnBanner(): JSX.Element | null {
  const { ongoing, peerName, setMobile } = useCalls();
  const { section } = useLayout();

  return ongoing && section !== 'calls' ? (
    <Link className="ongoing-call-banner" to="/calls" onClick={(): void => setMobile(true)}>
      <Phone size={18} aria-hidden="true" />
      <span>Вернуться к звонку · {peerName}</span>
    </Link>
  ) : null;
}
