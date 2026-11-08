import { z } from 'zod';

import type { DeviceFailure } from './api';
import { DeviceErrorCode } from './error-code';
import { deviceErrorMessage } from './messages';

export const permissionSchema = z.enum([
  'unknown',
  'prompt',
  'denied',
  'restricted',
  'granted',
  'limited',
]);

export const resourceSchema = z.enum(['microphone', 'camera', 'geolocation']);

export const permissionStateSchema = z.strictObject({
  permission: permissionSchema,
  settingsHint: z.enum(['appSettings', 'siteSettings', 'none']),
});

export const locationSchema = permissionStateSchema.extend({
  accuracy: z.enum(['full', 'reduced', 'unknown']),
  service: z.enum(['enabled', 'disabled', 'unknown']),
});

export const refSchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  kind: z.enum(['file', 'directory']),
  persistence: z.enum(['persistent', 'session']),
});

export const metadataSchema = z.strictObject({
  ref: refSchema,
  size: z.number().nonnegative().nullable(),
  modifiedAt: z.string().nullable(),
  mimeType: z.string().nullable(),
  version: z.string().nullable(),
});

export const testSchema = z.strictObject({
  id: z.uuid(),
  kind: z.enum(['microphone', 'sound']),
  status: z.enum(['running', 'completed', 'cancelled', 'failed']),
  errorCode: z.string().nullable(),
});

export const pushSchema = z.strictObject({
  permission: permissionSchema,
  alert: z.enum(['enabled', 'disabled', 'unknown']),
  sound: z.enum(['enabled', 'disabled', 'unknown']),
  badge: z.enum(['enabled', 'disabled', 'unknown']),
  delivery: z.enum(['unavailable', 'disabled', 'enabling', 'enabled', 'error']),
});

export const stateSchema = z.strictObject({
  revision: z.number().int().nonnegative().safe(),
  microphone: permissionStateSchema,
  camera: permissionStateSchema,
  geolocation: locationSchema,
  audio: z.strictObject({ routeName: z.string().nullable(), test: testSchema.nullable() }),
  push: pushSchema,
  files: z.strictObject({ retainedCount: z.number().int().nonnegative() }),
});

const empty = z.strictObject({});
const uuid = z.uuid();
const integer = z.number().int().nonnegative().safe();
const name = z
  .string()
  .min(1)
  .refine((v): boolean => !/[\/\\\0]/.test(v) && v !== '.' && v !== '..');
const outcome = z.enum(['completed', 'cancelled']);
const done = z.strictObject({ outcome });
const page = z.strictObject({
  cursor: z.string().nullable(),
  limit: z.number().int().min(1).max(200),
});
const id = z.strictObject({ id: uuid });
const target = z.strictObject({ id: uuid, destinationDirectoryId: uuid, name });

export const storageAreaSchema = z.enum(['data', 'temporary', 'cache']);

export const argsSchemas = {
  'storage.getRoot': z.strictObject({ area: storageAreaSchema }),
  'storage.getUsage': z.strictObject({ area: storageAreaSchema }),
  'device.state.read': empty,
  'device.changes.wait': z.strictObject({
    afterRevision: integer,
    timeoutMs: z.number().int().min(1000).max(30000),
  }),
  'device.changes.cancel': empty,
  'permission.read': z.strictObject({ resource: resourceSchema }),
  'permission.request': z.strictObject({ resource: resourceSchema }),
  'device.settings.open': empty,
  'audio.test.start': z.strictObject({ kind: z.enum(['microphone', 'sound']) }),
  'audio.test.stop': z.strictObject({ testId: uuid }),
  'audio.output.select': empty,
  'call.prepareOutgoing': empty,
  'push.enable': empty,
  'push.disable': empty,
  'file.pick': z.strictObject({
    multiple: z.boolean(),
    accept: z.array(z.string().regex(/^[\w.+-]+\/[\w.+*-]+$/)).max(50),
  }),
  'directory.pick': empty,
  'file.access.list': page,
  'file.access.restore': id,
  'file.access.forget': id,
  'file.stat': id,
  'directory.list': page.extend({ directoryId: uuid }),
  'file.read': z.strictObject({
    fileId: uuid,
    offset: integer,
    length: z.number().int().min(1).max(262144),
  }),
  'file.create': z.strictObject({ directoryId: uuid, name }),
  'directory.create': z.strictObject({ directoryId: uuid, name }),
  'file.write.begin': z.strictObject({
    fileId: uuid,
    mode: z.enum(['replace', 'update']),
    expectedVersion: z.string().nullable(),
  }),
  'file.write.chunk': z.strictObject({
    writeId: uuid,
    offset: integer,
    dataBase64: z
      .string()
      .max(349528)
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  }),
  'file.write.commit': z.strictObject({ writeId: uuid }),
  'file.write.abort': z.strictObject({ writeId: uuid }),
  'file.saveAs': z.strictObject({ sourceFileId: uuid, suggestedName: name }),
  'file.export': z.strictObject({ sourceFileId: uuid, suggestedName: name }),
  'file.copy': target,
  'file.move': target,
  'file.rename': z.strictObject({ id: uuid, name }),
  'file.remove': z.strictObject({ id: uuid, recursive: z.boolean() }),
};

export const resultsSchemas = {
  'storage.getRoot': refSchema,
  'storage.getUsage': z.strictObject({
    usedBytes: integer.nullable(),
    quotaBytes: integer.nullable(),
  }),
  'device.state.read': stateSchema,
  'device.changes.wait': z.strictObject({
    revision: integer,
    changed: z.array(z.enum(['microphone', 'camera', 'geolocation', 'audio', 'push', 'files'])),
    timedOut: z.boolean(),
  }),
  'device.changes.cancel': done,
  'permission.read': z.union([permissionStateSchema, locationSchema]),
  'permission.request': z.strictObject({
    outcome,
    state: z.union([permissionStateSchema, locationSchema]),
  }),
  'device.settings.open': done,
  'audio.test.start': z.strictObject({ testId: uuid }),
  'audio.test.stop': done,
  'audio.output.select': z.strictObject({ outcome, routeName: z.string().nullable() }),
  'call.prepareOutgoing': z.strictObject({ outcome, microphone: permissionStateSchema }),
  'push.enable': z.strictObject({ outcome, push: pushSchema }),
  'push.disable': z.strictObject({ outcome, push: pushSchema }),
  'file.pick': z.strictObject({ outcome, entries: z.array(metadataSchema) }),
  'directory.pick': z.strictObject({ outcome, entry: metadataSchema.nullable() }),
  'file.access.list': z.strictObject({
    entries: z.array(refSchema),
    nextCursor: z.string().nullable(),
  }),
  'file.access.restore': metadataSchema,
  'file.access.forget': done,
  'file.stat': metadataSchema,
  'directory.list': z.strictObject({
    entries: z.array(metadataSchema),
    nextCursor: z.string().nullable(),
  }),
  'file.read': z.strictObject({
    dataBase64: z.string(),
    bytesRead: integer,
    eof: z.boolean(),
    version: z.string().nullable(),
  }),
  'file.create': metadataSchema,
  'directory.create': metadataSchema,
  'file.write.begin': z.strictObject({ writeId: uuid }),
  'file.write.chunk': z.strictObject({ bytesWritten: integer }),
  'file.write.commit': metadataSchema,
  'file.write.abort': done,
  'file.saveAs': z.strictObject({ outcome, entry: metadataSchema.nullable() }),
  'file.export': done,
  'file.copy': metadataSchema,
  'file.move': metadataSchema,
  'file.rename': metadataSchema,
  'file.remove': done,
};

export type Command = keyof typeof argsSchemas;

export type Args<C extends Command> = z.input<(typeof argsSchemas)[C]>;

export type Result<C extends Command> = z.output<(typeof resultsSchemas)[C]>;

export type DeviceState = z.infer<typeof stateSchema>;

export type PermissionState = z.infer<typeof permissionStateSchema>;

export type Resource = z.infer<typeof resourceSchema>;

export type FileRef = z.infer<typeof refSchema>;

export type Metadata = z.infer<typeof metadataSchema>;

export interface DeviceBridge {
  execute<C extends Command>(request: { command: C; args: Args<C> }): Promise<Result<C>>;
}

export class DeviceError extends Error {
  readonly details: Record<string, unknown>;
  readonly command?: string;
  readonly settingsHint?: string;
  readonly outcome?: string;
  readonly completedIds?: string[];
  readonly destinationId?: string;

  readonly code: DeviceErrorCode;
  readonly service: string;
  readonly operation: string;

  constructor(failure: DeviceFailure);
  constructor(code: string, details?: Record<string, unknown>);
  constructor(input: string | DeviceFailure, details: Record<string, unknown> = {}) {
    const raw = typeof input === 'string' ? input : input.code;
    const code =
      Object.values(DeviceErrorCode).find((value): boolean => value === raw) ??
      DeviceErrorCode.OperationFailed;

    super(deviceErrorMessage({ code }));
    this.code = code;
    this.service =
      typeof input === 'string'
        ? typeof details.command === 'string'
          ? details.command.split('.')[0]
          : 'device'
        : input.service;
    this.operation =
      typeof input === 'string'
        ? typeof details.command === 'string'
          ? details.command
          : 'operation'
        : input.operation;
    details = typeof input === 'string' ? details : { ...input.details };

    this.details = {
      ...(code === 'OUTCOME_UNKNOWN'
        ? { outcome: 'unknown' }
        : code === 'PARTIAL_FAILURE'
          ? { outcome: 'partial' }
          : {}),
      ...details,
    };
    this.command = typeof details.command === 'string' ? details.command : undefined;
    this.settingsHint = typeof details.settingsHint === 'string' ? details.settingsHint : undefined;
    this.outcome = typeof this.details.outcome === 'string' ? this.details.outcome : undefined;
    this.destinationId =
      typeof details.destinationId === 'string' ? details.destinationId : undefined;
    this.completedIds = Array.isArray(details.completedIds)
      ? details.completedIds.filter((id): id is string => typeof id === 'string')
      : undefined;
  }
}

export function failure(error: unknown): DeviceError {
  if (error instanceof DeviceError) {
    return error;
  }

  if (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    typeof error.name === 'string'
  ) {
    const codes: Record<string, string> = {
      AbortError: 'CANCELLED',
      NotAllowedError: 'PERMISSION_DENIED',
      SecurityError: 'PERMISSION_DENIED',
      NotFoundError: 'NOT_FOUND',
      NotReadableError: 'DEVICE_UNAVAILABLE',
      OverconstrainedError: 'DEVICE_UNAVAILABLE',
      NotSupportedError: 'UNSUPPORTED',
      QuotaExceededError: 'STORAGE_FULL',
      InvalidModificationError: 'CONFLICT',
    };

    return new DeviceError(codes[error.name] ?? 'IO_ERROR');
  }

  return new DeviceError('IO_ERROR');
}

export function commandExists(value: string): value is Command {
  return Object.hasOwn(argsSchemas, value);
}
