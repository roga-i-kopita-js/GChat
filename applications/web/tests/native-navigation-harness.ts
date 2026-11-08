import { createBrowserRouter, type LoaderFunctionArgs, redirect } from 'react-router';
import { z } from 'zod';

import { resolveNativeLocation } from '../src/app/native-location';
import { DeviceNavigation, NavigationEvent } from '../src/shared/device/navigation';
import { NativeNavigationBinding } from '../src/shared/device/navigation-native';
import { nativePlugin } from '../src/shared/native/bridge';

type Metrics = { navigationCheck: string; passed: boolean; navigationOutcome?: string };
let reporter: (value: Metrics) => void = (): void => {};
let cycle: string | undefined;
let release: (() => void) | undefined;
let hold = false;
let nativePassed = false;
let nativeCompleted: (() => void) | undefined;
const nativeDone = new Promise<void>((resolve): void => {
  nativeCompleted = resolve;
});
const router = createBrowserRouter(
  [
    { path: '/', loader: (): Response => redirect('/calls') },
    { path: '/login', loader: (): null => null },
    { path: '/calls', loader: (): null => null },
    { path: '/settings', loader: (): Response => redirect('/settings/general/audio') },
    {
      path: '/settings/general/audio',
      loader: ({ request }: LoaderFunctionArgs): null | Promise<null> => {
        if (!hold) {
          return null;
        }

        return new Promise<null>((resolve): void => {
          const finish = (): void => {
            request.signal.removeEventListener('abort', finish);
            resolve(null);
          };

          release = finish;
          request.signal.addEventListener('abort', finish, { once: true });
        });
      },
    },
    {
      path: '/admin/users',
      loader: (): never => {
        throw new Error('Fixture route loader failure');
      },
    },
  ],
  { basename: '/apps/client' },
);
const navigation = new DeviceNavigation(
  router,
  (to): string => resolveNativeLocation(to, window.location.origin),
  '/apps/client',
);
const binding = new NativeNavigationBinding(nativePlugin, navigation);
const checkSchema = z.strictObject({
  cycleId: z.uuid(),
  check: z.literal('native-roundtrip'),
  passed: z.boolean(),
});
let checkListener: Promise<unknown> | undefined;

export async function startNavigationHarness(
  nextCycle: string,
  report: (value: Metrics) => void,
): Promise<void> {
  cycle = nextCycle;
  reporter = report;
  checkListener ??= nativePlugin.addListener('navigationCheck', (raw): void => {
    const value = checkSchema.safeParse(raw);

    if (value.success && value.data.cycleId === cycle) {
      reporter({ navigationCheck: 'native-roundtrip', passed: value.data.passed });
      nativePassed = value.data.passed;
      nativeCompleted?.();
    }
  });
  await checkListener;
  await binding.start(nextCycle);
}

async function until(predicate: () => boolean): Promise<void> {
  if (predicate()) {
    return;
  }

  await new Promise<void>((resolve, reject): void => {
    const timeout = setTimeout((): void => {
      off();
      reject(new Error('Navigation fixture timed out'));
    }, 10000);
    const off = router.subscribe((): void => {
      if (predicate()) {
        clearTimeout(timeout);
        off();
        resolve();
      }
    });
  });
}

export async function runNavigationChecks(waitForNative = false): Promise<void> {
  if (waitForNative) {
    let timeout: ReturnType<typeof setTimeout> | undefined;

    try {
      await Promise.race([
        nativeDone,
        new Promise<never>((_, reject): void => {
          timeout = setTimeout((): void => reject(new Error('Native roundtrip timed out')), 15000);
        }),
      ]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  if (waitForNative && !nativePassed) {
    throw new Error('Native roundtrip failed');
  }

  const check = (navigationCheck: string, passed: boolean, navigationOutcome?: string): void => {
    reporter({ navigationCheck, passed, ...(navigationOutcome ? { navigationOutcome } : {}) });

    if (!passed) {
      throw new Error('Navigation fixture failed');
    }
  };
  let result = await navigation.navigate('/calls', { replace: true });

  check('committed', result.outcome === 'committed', result.outcome);
  result = await navigation.navigate('/settings');
  check('redirected', result.outcome === 'redirected', result.outcome);
  result = await navigation.navigate('/admin/users');
  check('loader-failed', result.outcome === 'failed', result.outcome);
  await navigation.navigate('/calls');
  hold = true;
  const old = navigation.navigate('/settings/general/audio');

  await until((): boolean => router.state.navigation.state === 'loading');
  result = await navigation.navigate('/calls');
  const previous = await old;

  check(
    'superseded',
    previous.outcome === 'superseded' && result.outcome === 'committed',
    previous.outcome,
  );
  hold = false;
  release?.();
  router.getBlocker('harness-dirty-form', (): boolean => true);
  const blocked = navigation.navigate('/settings/general/audio');

  await until((): boolean => router.state.blockers.get('harness-dirty-form')?.state === 'blocked');
  const blocker = router.state.blockers.get('harness-dirty-form');

  if (blocker?.state === 'blocked') {
    blocker.reset();
  }

  result = await blocked;
  check('blocked', result.outcome === 'blocked', result.outcome);
  const proceed = navigation.navigate('/settings');

  await until((): boolean => router.state.blockers.get('harness-dirty-form')?.state === 'blocked');
  const allowed = router.state.blockers.get('harness-dirty-form');

  if (allowed?.state === 'blocked') {
    allowed.proceed();
  }

  result = await proceed;
  check('blocker-proceeded', result.outcome === 'redirected', result.outcome);
  router.deleteBlocker('harness-dirty-form');
  const revision = (await navigation.getState()).revision;

  await navigation.revalidate();
  check('revision-preserved', (await navigation.getState()).revision >= revision);
  const controller = new AbortController();

  controller.abort();
  let cancelled = false;

  try {
    await navigation.navigate('/calls', { signal: controller.signal });
  } catch (error) {
    cancelled = error instanceof Error && 'code' in error && error.code === 'CANCELLED';
  }

  check('aborted-before-start', cancelled);
  await navigation.navigate('/calls', { replace: true });
}

navigation.on(NavigationEvent.Completed, (event): void => {
  reporter({
    navigationCheck: 'completed-event',
    passed: true,
    navigationOutcome: event.result.outcome,
  });
});

export async function runFetchChecks(
  report: (value: { fetchCheck: string; passed: boolean }) => void,
): Promise<void> {
  const { nativeHttp } = await import('../src/shared/native/bridge');
  const controller = new AbortController();

  nativeHttp.activate(cycle!, location.origin, controller.signal);
  const request = nativeHttp.request;
  const check = (name: string, passed: boolean): void => {
    report({ fetchCheck: name, passed });

    if (!passed) {
      throw new Error('Fetch fixture failed');
    }
  };
  const bytes = await request('/api/bridge-fixture/bytes');
  const clone = bytes.clone();

  check(
    'response-clone',
    bytes instanceof Response &&
      bytes.url.endsWith('/api/bridge-fixture/bytes') &&
      bytes.type === 'basic' &&
      clone.type === 'basic' &&
      clone.url === bytes.url &&
      !bytes.redirected &&
      !bytes.headers.has('set-cookie'),
  );
  check(
    'binary-body',
    [...new Uint8Array(await bytes.arrayBuffer())].join(',') === '0,1,2,255' &&
      [...new Uint8Array(await clone.arrayBuffer())].join(',') === '0,1,2,255',
  );
  const empty = await request('/api/bridge-fixture/empty');
  const notModified = await request('/api/bridge-fixture/not-modified-large');
  const head = await request('/api/bridge-fixture/head-large', { method: 'HEAD' });

  check(
    'bodyless',
    empty.status === 204 &&
      empty.body === null &&
      notModified.status === 304 &&
      notModified.body === null &&
      head.status === 200 &&
      head.body === null,
  );
  const invalid = await request('/api/bridge-fixture/error');

  check('http-error', invalid.status === 422 && (await invalid.json()).fixture === true);

  for (const [name, url, code] of [
    ['redirect-rejected', '/api/bridge-fixture/redirect', 'NETWORK_ERROR'],
    ['response-limit', '/api/bridge-fixture/large', 'UNSUPPORTED'],
    ['foreign-origin', 'https://example.invalid/api', 'INVALID_ARGUMENT'],
  ]) {
    let passed = false;

    try {
      await request(url);
    } catch (error) {
      passed = error instanceof TypeError && (error.cause as { code?: string })?.code === code;
    }

    check(name, passed);
  }

  let cancelled = false;
  const pending = request('/api/bridge-fixture/slow', { signal: controller.signal }).catch(
    (error: unknown): void => {
      cancelled = error instanceof DOMException && error.name === 'AbortError';
    },
  );

  await new Promise<void>((resolve): void => {
    setTimeout(resolve, 100);
  });
  controller.abort();
  await pending;
  check('cancelled', cancelled);
  nativeHttp.activate(cycle!, location.origin, new AbortController().signal);
  check('usable-after-cancel', (await request('/api/bridge-fixture/empty')).status === 204);
}
