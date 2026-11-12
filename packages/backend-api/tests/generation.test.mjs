import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { validateSchema } from '../scripts/validate-schema.mjs';

const schema = JSON.parse(await readFile(new URL('../openapi.json', import.meta.url), 'utf8'));

test('real schema contains all operations', () => {
  const operations = validateSchema(schema);

  assert.equal(operations.length, 24);
  assert.deepEqual(
    operations
      .filter(({ operation }) => operation.operationId.startsWith('callsHistory'))
      .map(({ operation }) => operation.operationId)
      .sort(),
    ['callsHistoryGet', 'callsHistoryList'],
  );
  assert.deepEqual(
    operations
      .map(({ operation }) => operation.operationId)
      .filter((id) => id.startsWith('dialogs'))
      .sort(),
    [
      'dialogsCreate',
      'dialogsGet',
      'dialogsHistory',
      'dialogsList',
      'dialogsPermissions',
      'dialogsRead',
      'dialogsSendMessage',
    ],
  );
});

for (const [name, modify] of [
  [
    'missing operationId',
    (s) => {
      delete s.paths['/health'].get.operationId;
    },
  ],
  [
    'duplicate operationId',
    (s) => {
      s.paths['/health'].get.operationId = 'authLogin';
    },
  ],
  [
    'reserved method',
    (s) => {
      s.paths['/health'].get.operationId = 'constructor';
    },
  ],
  [
    'broken ref',
    (s) => {
      s.components.schemas.ErrorResponseDto.properties.error.$ref = '#/missing';
    },
  ],
  [
    'missing body schema',
    (s) => {
      delete s.paths['/auth/login'].post.requestBody.content['application/json'].schema;
    },
  ],
  [
    'missing success response',
    (s) => {
      delete s.paths['/health'].get.responses;
    },
  ],
  [
    'missing path parameter',
    (s) => {
      s.paths['/groups/{group_id}/members'].get.parameters = [];
    },
  ],
  [
    'unsupported serialization',
    (s) => {
      s.paths['/admin/users'].get.parameters[0].style = 'deepObject';
    },
  ],
]) {
  test(`generation rejects ${name}`, () => {
    const invalid = structuredClone(schema);

    modify(invalid);
    assert.throws(() => validateSchema(invalid));
  });
}
