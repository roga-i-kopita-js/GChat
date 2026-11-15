import type { LoaderFunctionArgs } from 'react-router';

import { applicationCore, userContext } from '../../app/router-context';
import { dialogBootstrap } from '../../shared/dialogs/bootstrap';

export interface ForwardRecipient {
  id: string;
  display_name: string;
  can_send: boolean;
}

export async function forwardRecipientsLoader({
  context,
  request,
}: LoaderFunctionArgs): Promise<{ recipients: ForwardRecipient[]; error?: string }> {
  try {
    const device = applicationCore(context);
    const user = context.get(userContext);
    const people = new Map<string, ForwardRecipient>();

    const runtime = await dialogBootstrap(device).ready(request.signal);
    const { listModel: runtimeListModel13 } = runtime;

    const list = await runtimeListModel13.bind(runtime)().getState();
    const { items: listItems150 } = list;

    for (const dialog of listItems150) {
      people.set(dialog.peer_id, {
        id: dialog.peer_id,
        display_name: dialog.peer_display_name,
        can_send: false,
      });
    }

    if (user.role === 'admin') {
      let offset = 0;

      for (;;) {
        const { data } = await device.session.run(
          (api, signal) =>
            api.adminListUsers({ query: { status: 'active', limit: 100, offset }, signal }),
          { signal: request.signal },
        );

        for (const person of data.users) {
          people.set(person.id, {
            id: person.id,
            display_name: person.display_name,
            can_send: true,
          });
        }

        offset += data.users.length;

        if (!data.users.length || offset >= data.total) {
          break;
        }
      }
    } else {
      const { data } = await device.session.run((api, signal) => api.groupsList({ signal }), {
        signal: request.signal,
      });

      for (const group of data.groups) {
        const { data: members } = await device.session.run(
          (api, signal) => api.groupsListMembers({ path: { group_id: group.id }, signal }),
          { signal: request.signal },
        );

        for (const person of members.members) {
          people.set(person.id, { ...person, can_send: true });
        }
      }
    }

    people.delete(user.sub);

    return {
      recipients: [...people.values()].sort((a, b) =>
        a.display_name.localeCompare(b.display_name, 'ru'),
      ),
    };
  } catch {
    request.signal.throwIfAborted();

    return { recipients: [], error: 'Не удалось загрузить получателей. Повторите попытку.' };
  }
}
