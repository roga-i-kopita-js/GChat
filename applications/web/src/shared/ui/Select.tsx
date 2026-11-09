import './tokens.css';
import './Select.css';

import { ChevronDown } from 'lucide-react';
import type { JSX, ReactNode } from 'react';

export function Select({
  'aria-label': ariaLabel,
  children,
  className = '',
  onChange,
  value,
}: {
  'aria-label': string;
  children: ReactNode;
  className?: string;
  onChange: (value: string) => void;
  value: string;
}): JSX.Element {
  return (
    <div className={'ui-select' + (className ? ` ${className}` : '')}>
      <select
        aria-label={ariaLabel}
        className="ui-select-control"
        value={value}
        onChange={(event): void => onChange(event.currentTarget.value)}
      >
        {children}
      </select>
      <ChevronDown className="ui-select-icon" aria-hidden="true" />
    </div>
  );
}
