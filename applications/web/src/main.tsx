import './style.css';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';

import { App } from './app/App';
import { NativeLaunchSpike } from './experiments/NativeLaunchSpike';
import { embedded } from './shared/native/bridge';
import { startUpdates } from './shared/pwa-update';

startUpdates();

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30000, retry: 1 } },
});
const root = document.getElementById('root');
const nativeLaunchSpike =
  import.meta.env.VITE_GCHAT_IOS_LAUNCH_SPIKE === 'true' &&
  !embedded &&
  new URLSearchParams(window.location.search).get('native_launch_spike') === '1';

if (root && nativeLaunchSpike) createRoot(root).render(<NativeLaunchSpike />);
else if (root)
  createRoot(root).render(
    <QueryClientProvider client={queryClient}>
      <BrowserRouter
        basename={embedded || import.meta.env.BASE_URL === '/apps/' ? '/apps/client' : '/'}
      >
        <App />
      </BrowserRouter>
    </QueryClientProvider>,
  );
