import { emitKeypressEvents } from 'node:readline';
import { parseArgs } from 'node:util';

export function parseAdminArgs(args: string[]): {
  display_name: string;
  login: string;
  group?: string;
} {
  const { values } = parseArgs({
    args,
    options: {
      'display-name': { type: 'string' },
      login: { type: 'string' },
      group: { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  });

  if (!values['display-name'] || !values.login) {
    throw new Error('Required: --display-name and --login');
  }

  return { display_name: values['display-name'], login: values.login, group: values.group };
}

export async function readHiddenPassword(): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Interactive terminal required');
  }

  const input = process.stdin;
  const wasRaw = input.isRaw;

  emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();
  process.stdout.write('Пароль: ');

  try {
    return await new Promise<string>((resolve, reject): void => {
      let password = '';
      const finish = (): void => {
        input.off('keypress', onKey);
      };
      const onKey = (text: string | undefined, key: { name?: string; ctrl?: boolean }): void => {
        if (key.ctrl && (key.name === 'c' || key.name === 'd')) {
          finish();
          reject(new Error('Cancelled'));
        } else if (key.name === 'return' || key.name === 'enter') {
          finish();
          resolve(password);
        } else if (key.name === 'backspace') {
          password = [...password].slice(0, -1).join('');
        } else if (text && !key.ctrl && !/[\x00-\x1f\x7f]/.test(text)) {
          password += text;
        }
      };

      input.on('keypress', onKey);
    });
  } finally {
    input.setRawMode(wasRaw);
    input.pause();
    process.stdout.write('\n');
  }
}
