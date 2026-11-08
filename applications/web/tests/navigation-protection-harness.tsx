import { type ReactElement, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, Link, Outlet, RouterProvider } from 'react-router';

import { SessionEvent, type SessionService, type SessionState } from '../src/shared/device/api';
import { StateSource } from '../src/shared/device/events';
import { DeviceNavigation } from '../src/shared/device/navigation';
import {
  NativeNavigationBinding,
  type NativeNavigationPort,
} from '../src/shared/device/navigation-native';
import {
  NavigationProtectionRoot,
  useNavigationProtection,
} from '../src/shared/navigation-protection';

export const control = {
  mode: 'form',
  fail: false,
  stored: '',
  lastOutcome: '',
  nativeOutcomes: [] as string[],
};

const state = new StateSource<SessionState>({
  revision: 0,
  status: 'authenticated',
  identity: { id: 'fixture', login: 'fixture', displayName: 'Fixture', role: 'user' },
  generation: 1,
  error: null,
});
const session: SessionService<unknown> = {
  getState: state.getState,
  on: (_event: SessionEvent.StateChanged, handler): (() => void) => state.on(handler),
  login: async (): Promise<never> => {
    throw new Error('Unused login');
  },
  logout: async (): Promise<never> => {
    throw new Error('Unused logout');
  },
  run: async (): Promise<never> => {
    throw new Error('Unused HTTP');
  },
};

function Shell(): ReactElement {
  return (
    <NavigationProtectionRoot session={session}>
      <Outlet />
    </NavigationProtectionRoot>
  );
}
function Form(): ReactElement {
  const [value, setValue] = useState('');
  const dirty = useRef(false);

  useNavigationProtection({
    dirty: (): boolean => dirty.current,
    flush:
      control.mode === 'draft'
        ? async (): Promise<void> => {
            if (control.fail) {
              throw new Error('Fixture storage unavailable');
            }

            control.stored = value;
            dirty.current = false;
          }
        : undefined,
    discard: (): void => {
      dirty.current = false;
      setValue('');
    },
  });

  return (
    <main>
      <h1>Protected form</h1>
      <input
        aria-label="Draft"
        value={value}
        onChange={(event): void => {
          dirty.current = event.target.value !== '';
          setValue(event.target.value);
        }}
      />
      <Link to="/next">Next</Link>
    </main>
  );
}
const router = createBrowserRouter([
  {
    element: <Shell />,
    children: [
      { path: '/form', element: <Form /> },
      {
        path: '/next',
        element: (
          <main>
            <h1>Next route</h1>
          </main>
        ),
      },
      { path: '*', element: <main /> },
    ],
  },
]);

export const navigation = new DeviceNavigation(router, (to): string => to, '/');

let receive: ((value: unknown) => void) | null = null;
const port: NativeNavigationPort = {
  addListener: async (_name, handler): Promise<{ remove(): Promise<void> }> => {
    receive = handler;

    return {
      remove: async (): Promise<void> => {
        receive = null;
      },
    };
  },
  navigationReady: async (): Promise<void> => {},
  completeNavigation: async (value): Promise<void> => {
    const result = value.result;

    if (
      typeof result === 'object' &&
      result !== null &&
      'outcome' in result &&
      typeof result.outcome === 'string'
    ) {
      control.nativeOutcomes.push(result.outcome);
    }
  },
};
const binding = new NativeNavigationBinding(port, navigation);
const cycle = '00000000-0000-4000-8000-000000000001';

export async function start(mode: 'form' | 'draft', fail = false): Promise<void> {
  control.mode = mode;
  control.fail = fail;
  await navigation.navigate('/form');
  const target = document.getElementById('root');

  if (!target) {
    throw new Error('Missing fixture root');
  }

  createRoot(target).render(<RouterProvider router={router} />);
  await binding.start(cycle);
}

export function command(native: boolean): void {
  if (native) {
    receive?.({
      navigationVersion: 1,
      cycleId: cycle,
      requestId: crypto.randomUUID(),
      command: 'navigate',
      args: { to: '/next', replace: false },
    });
  } else {
    void navigation.navigate('/next').then((result): void => {
      control.lastOutcome = result.outcome;
    });
  }
}
