import type { Page } from '@playwright/test';

import type { DialogMessage } from '../../../../applications/web/src/shared/dialogs/model';

const uuid = (value: number): string =>
  '00000000-0000-4000-8000-' + String(value).padStart(12, '0');
const me = uuid(1);
const peer = uuid(2);
const dialogId = uuid(3);

export async function setupDialogUi(
  page: Page,
  options: {
    reactions?: 'single' | 'both';
    sendResult?: 'success' | 'unknown' | 'rejected';
    canSend?: boolean;
  } = {},
): Promise<{ release(): void; requests(): number }> {
  const messages: DialogMessage[] = Array.from({ length: 17 }, (_, index) => ({
    message_id: uuid(100 + index),
    client_message_id: uuid(200 + index),
    dialog_id: dialogId,
    sender_id: index % 2 ? peer : me,
    sequence: index + 1,
    created_at: new Date(Date.now() - (17 - index) * 60000).toISOString(),
    content: {
      kind: 'text',
      text: index === 16 ? 'Встречаемся завтра в 18:00?' : 'Сообщение ' + (index + 1),
    },
    status: 'read',
    version: 1,
    edited_at: null,
    edit_sequence: 0,
    last_edit_id: null,
    forward: null,
    reply: null,
    reactions: [],
    own_reaction_states: [],
    reaction_version: 0,
    reaction_sequence: 0,
    actions_verified: true,
  }));
  const reacted = messages.at(-1)!;

  if (options.reactions) {
    reacted.reactions =
      options.reactions === 'single'
        ? [{ emoji: '🔥', user_ids: [me] }]
        : [
            { emoji: '🔥', user_ids: [me] },
            { emoji: '❤', user_ids: [me, peer] },
            { emoji: '👍', user_ids: [peer] },
          ];
    reacted.own_reaction_states = reacted.reactions
      .filter(({ user_ids }) => user_ids.includes(me))
      .map(({ emoji }) => ({
        emoji,
        selected: true,
        version: 1,
        last_operation_id: uuid(500 + reacted.reactions.findIndex((cell) => cell.emoji === emoji)),
      }));
    reacted.reaction_version = options.reactions === 'single' ? 1 : 4;
    reacted.reaction_sequence = 1;
  }

  let release = (): void => {};
  let count = 0;

  await page.addInitScript(
    ({ me }) => {
      const now = Math.floor(Date.now() / 1000);

      localStorage.setItem(
        'gchat.session.v1',
        JSON.stringify({
          access_token:
            'e30.' +
            btoa(
              JSON.stringify({
                sub: me,
                sid: 'dialog-ui',
                login: 'review',
                role: 'user',
                display_name: 'Review',
                iat: now,
                exp: now + 3600,
              }),
            ) +
            '.test',
          refresh_token: 'dialog-ui-refresh',
          token_type: 'Bearer',
          deviceId: null,
          pending: null,
        }),
      );
    },
    { me },
  );
  await page.routeWebSocket('**/ws', (socket) => {
    socket.onMessage((raw) => {
      const command = JSON.parse(String(raw));

      socket.send(
        JSON.stringify({
          type: 'response',
          request_id: command.request_id,
          payload: command.type === 'device.register' ? { device_id: uuid(99) } : { call: null },
        }),
      );
    });
  });
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const url = new URL(route.request().url());
      const path = url.pathname;
      const last = messages.at(-1)!;
      const dialog = {
        dialog_id: dialogId,
        peer_id: peer,
        peer_display_name: 'Анна Смирнова',
        created_at: messages[0].created_at,
        last_message_at: last.created_at,
        last_message: last,
        last_sequence: last.sequence,
        last_edit_sequence: 0,
        last_reaction_sequence: reacted.reaction_sequence,
        last_read_sequence: last.sequence,
        peer_last_read_sequence: 17,
        has_unread_messages: false,
      };
      let json: unknown;

      if (path === '/api/auth/ws-ticket') {
        json = {
          ticket: 'dialog-ui-ticket',
          expires_at: new Date(Date.now() + 60000).toISOString(),
        };
      } else if (path === '/api/groups') {
        json = { groups: [{ id: uuid(4), name: 'Близкие' }] };
      } else if (path.endsWith('/members')) {
        json = { members: [{ id: peer, display_name: 'Анна Смирнова' }] };
      } else if (path === '/api/dialogs') {
        json = { dialogs: [dialog], has_more: false };
      } else if (path === '/api/dialogs/' + dialogId) {
        json = { dialog };
      } else if (path.endsWith('/permissions')) {
        json = { dialogs: { can_read: true, can_send: options.canSend ?? true } };
      } else if (path.endsWith('/messages') && route.request().method() === 'POST') {
        count++;

        if (options.sendResult === 'unknown') {
          await route.abort('failed');

          return;
        }

        if (options.sendResult === 'rejected') {
          await route.fulfill({
            status: 403,
            json: { error: { code: 'DIALOG_NOT_ALLOWED', message: 'Forbidden' } },
          });

          return;
        }

        await new Promise<void>((resolve) => {
          release = resolve;
        });
        const body = route.request().postDataJSON();
        const message: DialogMessage = {
          ...messages[0],
          message_id: uuid(700 + count),
          sender_id: me,
          client_message_id: body.client_message_id,
          content: body.content,
          sequence: messages.length + 1,
          status: 'sent',
          created_at: new Date().toISOString(),
        };

        messages.push(message);
        await route.fulfill({ status: 201, json: { message } });

        return;
      } else if (path.endsWith('/messages')) {
        const after = Number(url.searchParams.get('after_sequence') ?? 0);
        const before = Number(url.searchParams.get('before_sequence') ?? Number.MAX_SAFE_INTEGER);

        json = {
          messages: messages.filter(
            (message) => message.sequence > after && message.sequence < before,
          ),
          has_more: false,
        };
      } else if (path.endsWith('/message-edits')) {
        json = { messages: [], next_edit_sequence: 0, has_more: false };
      } else if (path.endsWith('/message-reactions')) {
        const cursor = Number(url.searchParams.get('after_reaction_sequence') ?? 0);

        json = {
          messages: reacted.reaction_sequence > cursor ? [reacted] : [],
          next_reaction_sequence: reacted.reaction_sequence,
          has_more: false,
        };
      } else if (path.endsWith('/read')) {
        json = { last_read_sequence: last.sequence };
      } else if (path === '/api/calls/history') {
        json = { items: [], next_cursor: null };
      } else {
        await route.fulfill({ status: 404, json: {} });

        return;
      }

      await route.fulfill({ json });
    },
  );
  await page.goto('/dialogs/' + dialogId);

  return { release: () => release(), requests: () => count };
}
