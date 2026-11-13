import { SquarePen } from 'lucide-react';
import type { JSX } from 'react';
import { Link } from 'react-router';

import { PageHeader, Text } from '../../shared/ui';

export function DialogsHeader(): JSX.Element {
  return (
    <PageHeader className="dialogs-header">
      <Text as="h1" variant="heading">
        Диалоги
      </Text>
      <Link
        to="/dialogs/contacts"
        className="dialog-icon"
        aria-label="Написать сообщение"
        title="Написать сообщение"
      >
        <SquarePen aria-hidden="true" />
      </Link>
    </PageHeader>
  );
}
