import { expect, test } from '@playwright/test';
test.use({
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
});

test.beforeEach(async ({ page }): Promise<void> => {
  await page.addInitScript((): void => {
    const claims = {
      sub: '00000000-0000-4000-8000-000000000001',
      sid: 'device-test-session',
      role: 'user',
      login: 'test',
      display_name: 'Test',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    };

    localStorage.setItem(
      'gchat.session.v1',
      JSON.stringify({
        access_token: 'e30.' + btoa(JSON.stringify(claims)) + '.test',
        refresh_token: 'test-refresh',
        token_type: 'Bearer',
        deviceId: null,
        pending: null,
      }),
    );
  });
  await page.route('**/device-ping', async (route): Promise<void> =>
    route.fulfill({ body: 'pong' }),
  );
  await page.route(
    (url): boolean => url.pathname.startsWith('/api/'),
    async (route): Promise<void> => route.fulfill({ status: 503, body: '{}' }),
  );
  await page.goto('/tests/device-harness.html');
});

test('factory preserves injected HTTP, owns one router, and stop is terminal', async ({
  page,
}): Promise<void> => {
  const result = await page.evaluate(async (): Promise<object> => {
    const path = '/tests/device-harness.ts';
    const { makeDevice, TestHttp } = await import(path);
    const device = makeDevice();
    const second = makeDevice();

    await Promise.all([device.lifecycle.start(), device.lifecycle.start()]);
    const reply = await device.session.run(
      (http: InstanceType<typeof TestHttp>, signal: AbortSignal): Promise<string> =>
        http.ping(signal),
    );
    let duplicate = '';

    try {
      await second.lifecycle.start();
    } catch (error) {
      duplicate = (error as { code: string }).code;
    }

    await second.lifecycle.stop();
    await device.navigation.navigate('/first');
    const location = await device.navigation.getState();

    await Promise.all([device.lifecycle.stop(), device.lifecycle.stop()]);
    let restart = '';

    try {
      await device.lifecycle.start();
    } catch (error) {
      restart = (error as { code: string }).code;
    }

    let storage = '';

    try {
      await device.storage.getRoot('data');
    } catch (error) {
      storage = (error as { code: string }).code;
    }

    return {
      reply,
      injected: device.http instanceof TestHttp,
      duplicate,
      restart,
      storage,
      location,
      phase: (await device.lifecycle.getState()).phase,
      execute: 'execute' in device,
    };
  });

  expect(result).toMatchObject({
    reply: 'pong',
    injected: true,
    duplicate: 'INTEGRATION_ERROR',
    restart: 'INVALID_STATE',
    storage: 'CANCELLED',
    phase: 'stopped',
    execute: false,
  });
});

test('public files stage bytes, persist refs across reload and cache successful commits', async ({
  page,
}): Promise<void> => {
  const ref = await page.evaluate(async (): Promise<string> => {
    const path = '/tests/device-harness.ts';
    const { makeDevice } = await import(path);
    const device = makeDevice();

    await device.lifecycle.start();
    const root = await device.storage.getRoot('data');
    const file = await device.files.create(root, 'public-api.bin');
    const write = await device.files.beginWrite(file.ref, {
      mode: 'replace',
      expectedVersion: file.version,
    });

    await write.write(0, new Uint8Array([0, 255, 1]));
    const saved = await write.commit();
    const again = await write.commit();

    if (saved.ref.id !== again.ref.id) {
      throw new Error('commit was not idempotent');
    }

    await write.abort();
    await device.lifecycle.stop();

    return saved.ref.id;
  });

  await page.reload();
  const bytes = await page.evaluate(async (id): Promise<number[]> => {
    const path = '/tests/device-harness.ts';
    const { makeDevice } = await import(path);
    const device = makeDevice();

    await device.lifecycle.start();
    const ref = { id, name: 'public-api.bin', kind: 'file', persistence: 'persistent' };
    const result = await device.files.read(ref, { offset: 0, length: 10 });

    await device.files.remove(ref, { recursive: false });
    await device.lifecycle.stop();

    return Array.from(result.data);
  }, ref);

  expect(bytes).toEqual([0, 255, 1]);
});

test('camera shares one source and publishes persistent photos and streamed recordings', async ({
  browser,
}): Promise<void> => {
  const context = await browser.newContext({ permissions: ['camera'] });
  const page = await context.newPage();

  await page.addInitScript((): void => {
    const claims = {
      sub: '00000000-0000-4000-8000-000000000001',
      sid: 'camera-session',
      role: 'user',
      login: 'test',
      display_name: 'Test',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    };

    localStorage.setItem(
      'gchat.session.v1',
      JSON.stringify({
        access_token: 'e30.' + btoa(JSON.stringify(claims)) + '.test',
        refresh_token: 'test-refresh',
        token_type: 'Bearer',
        deviceId: null,
        pending: null,
      }),
    );
  });
  await page.route(
    (url): boolean => url.pathname.startsWith('/api/'),
    async (route): Promise<void> => route.fulfill({ status: 503, body: '{}' }),
  );
  await page.addInitScript((): void => {
    const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);

    navigator.mediaDevices.getUserMedia = async (constraints): Promise<MediaStream> => {
      if (!constraints || typeof constraints.video !== 'object' || constraints.audio !== false) {
        throw new Error('Expected video-only capture');
      }

      const facing = constraints.video.facingMode;

      if (typeof facing !== 'object' || Array.isArray(facing) || facing.exact !== 'user') {
        throw new Error('Expected exact front camera');
      }

      // Chromium's synthetic device has no facing metadata. Simulate that hardware capability in this fixture.
      const stream = await capture({
        ...constraints,
        video: { ...constraints.video, facingMode: undefined },
      });

      for (const track of stream.getVideoTracks()) {
        const settings = track.getSettings.bind(track);

        track.getSettings = (): MediaTrackSettings => ({ ...settings(), facingMode: 'user' });
      }

      return stream;
    };
  });
  await page.goto('/tests/device-harness.html');
  const result = await page.evaluate(async (): Promise<object> => {
    const path = '/tests/device-harness.ts';
    const { makeDevice } = await import(path);
    const device = makeDevice();

    await device.lifecycle.start();
    const one = await device.camera.open({ facing: 'front' });
    const two = await device.camera.open({ facing: 'front' });
    const same = (await one.getStream()).id === (await two.getStream()).id;

    await one.release();
    const state = await two.getState();
    const photo = await two.takePhoto();
    const metadata = await device.files.stat(photo);
    const recording = await two.startRecording();
    const anotherPhoto = await two.takePhoto();
    const clip = await recording.stop();
    const repeated = await recording.stop();
    const video = await device.files.stat(clip);

    await two.release();
    await device.lifecycle.stop();

    return {
      same,
      state: state.status,
      photo: metadata,
      video,
      repeat: clip.id === repeated.id,
      another: anotherPhoto.persistence,
    };
  });

  expect(result).toMatchObject({
    same: true,
    state: 'streaming',
    photo: { mimeType: 'image/jpeg', ref: { persistence: 'persistent' } },
    video: { ref: { persistence: 'persistent' } },
    repeat: true,
    another: 'persistent',
  });
  await context.close();
});
