import 'reflect-metadata';

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { Controller, Get } from '@nestjs/common';
import { ApiOperation } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';

// Test-only keys and URLs; no developer .env or infrastructure is used.
createRequire(import.meta.url)('./setup-env.cjs');
const { AppModule } = await import('../dist/app.module.js');
const { DATABASE_POOL } = await import('../dist/database/database.constants.js');
const { REDIS_CLIENT } = await import('../dist/redis/redis.constants.js');
const { DirectCallsWorker } = await import('../dist/direct-calls/direct-calls.worker.js');
const { SignalingWorker } = await import('../dist/signaling/signaling.worker.js');
const { PushWorker } = await import('../dist/push/push.worker.js');
const { PushClient } = await import('../dist/push/push.client.js');
const { createOpenApiDocument } = await import('../dist/swagger/setup-swagger.js');
const { exportOpenApiDocument } = await import('../dist/swagger/export-openapi.js');

test('standalone OpenAPI equals the HTTP application document from the same Nest build', async () => {
  const forbidden = () => {
    throw new Error('OpenAPI must not contact infrastructure');
  };
  const builder = Test.createTestingModule({ imports: [AppModule] });

  for (const provider of [DirectCallsWorker, SignalingWorker, PushWorker, PushClient]) {
    builder.overrideProvider(provider).useValue({});
  }

  builder.overrideProvider(DATABASE_POOL).useValue({ query: forbidden, end: async () => {} });
  builder
    .overrideProvider(REDIS_CLIENT)
    .useValue({ isOpen: true, connect: forbidden, ping: forbidden, close: async () => {} });
  const module = await builder.compile();
  const { createNestApplication: moduleCreateNestApplication } = module;
  const app = moduleCreateNestApplication.bind(module)();

  try {
    const document = createOpenApiDocument(app);

    assert.deepEqual(await exportOpenApiDocument(), document);
    assert.equal(document.paths['/admin/users'].get.operationId, 'adminListUsers');
    assert.equal(
      document.paths['/admin/users'].get.parameters.every((p) => !p.required),
      true,
    );
    assert.equal(document.components.schemas.AdminUserDto.properties.disabled_at.nullable, true);
    assert.equal(document.paths['/auth/logout'].post.responses['204'].content, undefined);
    assert.deepEqual(document.paths['/groups'].get.security, [{ bearer: [] }]);
    assert.equal(document.paths['/health'].get.security, undefined);
    assert.equal(document.paths['/calls/history'].get.operationId, 'callsHistoryList');
    assert.equal(document.paths['/calls/history/{call_id}'].get.operationId, 'callsHistoryGet');
    assert.deepEqual(document.paths['/calls/history'].get.security, [{ bearer: [] }]);
    assert.deepEqual(document.paths['/calls/history/{call_id}'].get.security, [{ bearer: [] }]);
    const history = document.components.schemas.CallHistoryItemDto;

    assert.equal(history.properties.started_at.nullable, true);
    assert.equal(history.properties.duration_seconds.nullable, true);
    assert.equal(history.properties.duration_seconds.type, 'integer');
    assert.equal(history.properties.duration_seconds.minimum, 0);
    assert.equal(history.properties.peer_display_name.type, 'string');
    assert.deepEqual(history.properties.direction.enum, ['incoming', 'outgoing']);
    assert.equal(history.properties.outcome.enum.includes('missed'), true);
    assert.equal(history.properties.end_reason.enum.length, 8);
    assert.equal(
      document.components.schemas.CallHistoryListResponseDto.properties.next_cursor.nullable,
      true,
    );
    assert.deepEqual(document.components.schemas.CallHistoryResponseDto.required, ['item']);

    for (const code of ['400', '401', '403', '429', '500', '503']) {
      assert.ok(document.paths['/calls/history'].get.responses[code]);
    }

    assert.ok(document.paths['/calls/history/{call_id}'].get.responses['404']);
  } finally {
    await app.close();
  }
});

test('compiled export runs with an empty environment and without loading .env', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'gchat-openapi-isolated-'));

  try {
    const output = join(temporary, 'openapi.json');

    execFileSync(
      process.execPath,
      [fileURLToPath(new URL('../dist/swagger/export-openapi.js', import.meta.url)), output],
      { env: {}, cwd: temporary, stdio: 'pipe' },
    );
    assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), await exportOpenApiDocument());
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

async function documentFor(controllers) {
  const module = await Test.createTestingModule({ controllers }).compile();
  const { createNestApplication: moduleCreateNestApplication2 } = module;
  const app = moduleCreateNestApplication2.bind(module)();

  try {
    return createOpenApiDocument(app);
  } finally {
    await app.close();
  }
}

function decorate(ControllerClass, method, id) {
  Controller('example')(ControllerClass);
  const descriptor = Object.getOwnPropertyDescriptor(ControllerClass.prototype, method);

  Get()(ControllerClass.prototype, method, descriptor);

  if (id) {
    ApiOperation({ operationId: id })(ControllerClass.prototype, method, descriptor);
  }
}

test('renaming a controller and its method preserves the explicit operationId', async () => {
  class BeforeController {
    before() {}
  }

  class AfterController {
    after() {}
  }

  decorate(BeforeController, 'before', 'stableOperation');
  decorate(AfterController, 'after', 'stableOperation');
  const { paths: resultPaths } = await documentFor([BeforeController]);

  assert.equal(resultPaths['/example'].get.operationId, 'stableOperation');
  const { paths: resultPaths2 } = await documentFor([AfterController]);

  assert.equal(resultPaths2['/example'].get.operationId, 'stableOperation');
});

test('OpenAPI creation rejects absent and duplicate explicit IDs', async () => {
  class MissingController {
    missing() {}
  }

  decorate(MissingController, 'missing');
  await assert.rejects(documentFor([MissingController]), /operationId/);

  class FirstController {
    first() {}
  }

  class SecondController {
    second() {}
  }

  decorate(FirstController, 'first', 'duplicateOperation');
  decorate(SecondController, 'second', 'duplicateOperation');
  await assert.rejects(documentFor([FirstController, SecondController]), /operationId/);
});
