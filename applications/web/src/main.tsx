import './shared/ui/tokens.css';
import './style.css';

import { BackendApi } from '@gchat/backend-api';
import { createRoot } from 'react-dom/client';

import { resolveNativeLocation } from './app/native-location';
import { createApplicationRoutes } from './app/routes';
import {
  consumeNativeLaunchIntent,
  watchNativeLaunchIntent,
} from './experiments/native-launch-intent';
import { NativeLaunchSpike } from './experiments/NativeLaunchSpike';
import { createDevice } from './shared/device';
import { DeviceProvider } from './shared/device/react';
import { embedded } from './shared/native/bridge';

const root = document.getElementById('root');
const nativeLaunchSpike = import.meta.env.VITE_GCHAT_IOS_LAUNCH_SPIKE === 'true' && !embedded;

async function startApplication(): Promise<void> {
  if (!root) {
    return;
  }

  if (nativeLaunchSpike) {
    if (new URLSearchParams(window.location.search).get('native_launch_spike') === '1') {
      // Do not launch again after the user chooses “Stay in Web”.
      await consumeNativeLaunchIntent();
      createRoot(root).render(<NativeLaunchSpike />);

      return;
    }

    const startUrl =
      import.meta.env.BASE_URL === '/apps/' || window.location.pathname.startsWith('/apps/client')
        ? '/apps/client/calls'
        : '/calls';

    if (await watchNativeLaunchIntent(startUrl)) {
      return;
    }
  }

  const device = createDevice({
    http: { client: BackendApi, options: { baseUrl: '/api' } },
    routing: {
      basename:
        import.meta.env.BASE_URL === '/apps/' || window.location.pathname.startsWith('/apps/client')
          ? '/apps/client'
          : '/',
      createRoutes: createApplicationRoutes,
      resolveNativeLocation: (to): string | null => {
        try {
          return resolveNativeLocation(to, window.location.origin);
        } catch {
          return null;
        }
      },
    },
  });

  void (async () => {
    try {
      return await device.lifecycle.start();
    } catch (cause) {
    } finally {
      createRoot(root).render(<DeviceProvider device={device} />);
    }
  })();
}

void startApplication();
