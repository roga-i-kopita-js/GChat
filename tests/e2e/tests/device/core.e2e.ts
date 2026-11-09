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

    const { phase: getStateResultPhase } = await device.lifecycle.getState();

    return {
      reply,
      injected: device.http instanceof TestHttp,
      duplicate,
      restart,
      storage,
      location,
      phase: getStateResultPhase,
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
    const { ref: fileRef, version: fileVersion } = await device.files.create(
      root,
      'public-api.bin',
    );
    const write = await device.files.beginWrite(fileRef, {
      mode: 'replace',
      expectedVersion: fileVersion,
    });

    const { write: writeWrite } = write;

    await writeWrite.bind(write)(0, new Uint8Array([0, 255, 1]));
    const { commit: writeCommit } = write;
    const saved = await writeCommit.bind(write)();
    const { commit: writeCommit2 } = write;
    const again = await writeCommit2.bind(write)();

    const { ref: savedRef } = saved;
    const { ref: againRef } = again;

    if (savedRef.id !== againRef.id) {
      throw new Error('commit was not idempotent');
    }

    const { abort: writeAbort } = write;

    await writeAbort.bind(write)();
    await device.lifecycle.stop();

    const { ref: savedRef2 } = saved;

    return savedRef2.id;
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

    const { data: resultData } = result;

    return Array.from(resultData);
  }, ref);

  expect(bytes).toEqual([0, 255, 1]);
});

test('camera shares one source and publishes persistent photos and streamed recordings', async ({
  browser,
}): Promise<void> => {
  const context = await browser.newContext({ permissions: ['camera'] });
  const { newPage: contextNewPage } = context;
  const page = await contextNewPage.bind(context)();

  const { addInitScript: pageAddInitScript } = page;

  await pageAddInitScript.bind(page)((): void => {
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
  const { route: pageRoute } = page;

  await pageRoute.bind(page)(
    (url): boolean => url.pathname.startsWith('/api/'),
    async (route): Promise<void> => route.fulfill({ status: 503, body: '{}' }),
  );
  const { addInitScript: pageAddInitScript2 } = page;

  await pageAddInitScript2.bind(page)((): void => {
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

      const { getVideoTracks: streamGetVideoTracks } = stream;

      for (const track of streamGetVideoTracks.bind(stream)()) {
        const settings = track.getSettings.bind(track);

        track.getSettings = (): MediaTrackSettings => ({ ...settings(), facingMode: 'user' });
      }

      return stream;
    };
  });
  const { goto: pageGoto } = page;

  await pageGoto.bind(page)('/tests/device-harness.html');
  const { evaluate: pageEvaluate } = page;
  const result = await pageEvaluate.bind(page)(async (): Promise<object> => {
    const path = '/tests/device-harness.ts';
    const { makeDevice } = await import(path);
    const device = makeDevice();

    await device.lifecycle.start();
    const one = await device.camera.open({ facing: 'front' });
    const two = await device.camera.open({ facing: 'front' });
    const { getStream: oneGetStream } = one;
    const { getStream: twoGetStream } = two;
    const { id: resultId } = await oneGetStream.bind(one)();
    const { id: resultId2 } = await twoGetStream.bind(two)();
    const same = resultId === resultId2;

    const { release: oneRelease } = one;

    await oneRelease.bind(one)();
    const { getState: twoGetState } = two;
    const state = await twoGetState.bind(two)();
    const { takePhoto: twoTakePhoto } = two;
    const photo = await twoTakePhoto.bind(two)();
    const metadata = await device.files.stat(photo);
    const { startRecording: twoStartRecording } = two;
    const recording = await twoStartRecording.bind(two)();
    const { takePhoto: twoTakePhoto2 } = two;
    const anotherPhoto = await twoTakePhoto2.bind(two)();
    const { stop: recordingStop } = recording;
    const clip = await recordingStop.bind(recording)();
    const { stop: recordingStop2 } = recording;
    const repeated = await recordingStop2.bind(recording)();
    const video = await device.files.stat(clip);

    const { release: twoRelease } = two;

    await twoRelease.bind(two)();
    await device.lifecycle.stop();

    const { status: stateStatus } = state;
    const { id: clipId } = clip;
    const { id: repeatedId } = repeated;
    const { persistence: anotherPhotoPersistence } = anotherPhoto;

    return {
      same,
      state: stateStatus,
      photo: metadata,
      video,
      repeat: clipId === repeatedId,
      another: anotherPhotoPersistence,
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
  const { close: contextClose } = context;

  await contextClose.bind(context)();
});
