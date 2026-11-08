import './style.css';

import { BackendApi } from '@gchat/backend-api';
import { createRoot } from 'react-dom/client';

import { resolveNativeLocation } from './app/native-location';
import { createApplicationRoutes } from './app/routes';
import { NativeLaunchSpike } from './experiments/NativeLaunchSpike';
import { createDevice } from './shared/device';
import { DeviceProvider } from './shared/device/react';
import { embedded } from './shared/native/bridge';

const root = document.getElementById('root');
const nativeLaunchSpike =
  import.meta.env.VITE_GCHAT_IOS_LAUNCH_SPIKE === 'true' &&
  !embedded &&
  new URLSearchParams(window.location.search).get('native_launch_spike') === '1';

if (root && nativeLaunchSpike) {
  createRoot(root).render(<NativeLaunchSpike />);
} else if (root) {
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

  void device.lifecycle
    .start()
    .catch((): void => {})
    .finally((): void => {
      createRoot(root).render(<DeviceProvider device={device} />);
    });
}
