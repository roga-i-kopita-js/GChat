import { parseAdminArgs } from './admin-cli.input.js';

describe('Administrator CLI arguments', (): void => {
  it('requires explicit login/name and allows an optional group', (): void => {
    expect(parseAdminArgs(['--display-name', 'Admin', '--login', 'admin'])).toEqual({
      display_name: 'Admin',
      login: 'admin',
      group: undefined,
    });
    expect(
      parseAdminArgs(['--display-name', 'Admin', '--login', 'admin', '--group', 'Family']).group,
    ).toBe('Family');
  });
  it.each(
    [
      [],
      ['--login', 'admin'],
      ['--display-name', 'Admin'],
      ['--display-name', 'Admin', '--login', 'admin', '--password', 'secret'],
      ['--display-name', 'Admin', '--login', 'admin', '--role', 'user'],
      ['disable', '--login', 'admin'],
    ].map((args): { args: string[] } => ({ args })),
  )('rejects missing fields and unsupported operations or secrets: %j', ({ args }): void => {
    expect((): unknown => parseAdminArgs(args)).toThrow();
  });
});
