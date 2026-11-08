import 'reflect-metadata';

import { readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { Type } from '@nestjs/common';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import type { OpenAPIObject } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';

import { createOpenApiDocument } from './setup-swagger.js';

/** Discover compiled HTTP controllers without importing AppModule or infrastructure modules. */
function isController(value: unknown): value is Type<unknown> {
  return typeof value === 'function' && Reflect.hasMetadata(PATH_METADATA, value);
}

async function discoverControllers(root: string): Promise<Type<unknown>[]> {
  const controllers: Type<unknown>[] = [];
  const files = await readdir(root, { recursive: true });

  for (const file of files.sort()) {
    if (!file.endsWith('.controller.js')) {
      continue;
    }

    const exports: Record<string, unknown> = await import(pathToFileURL(join(root, file)).href);

    for (const value of Object.values(exports)) {
      if (isController(value)) {
        controllers.push(value);
      }
    }
  }

  return controllers;
}

export async function exportOpenApiDocument(): Promise<OpenAPIObject> {
  const controllers = await discoverControllers(
    resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  );
  const tokens = new Set<Type<unknown>>();

  for (const controller of controllers) {
    const dependencies: Type<unknown>[] =
      Reflect.getMetadata('design:paramtypes', controller) ?? [];

    for (const dependency of dependencies) {
      tokens.add(dependency);
    }

    const targets = [
      controller,
      ...Object.getOwnPropertyNames(controller.prototype)
        .map((name): unknown => controller.prototype[name])
        .filter((value): value is object => typeof value === 'function'),
    ];

    for (const target of targets) {
      const guards: Type<unknown>[] = Reflect.getMetadata(GUARDS_METADATA, target) ?? [];

      for (const guard of guards) {
        tokens.add(guard);
      }
    }
  }

  const builder = Test.createTestingModule({
    controllers,
    providers: [...tokens].map((provide): { provide: Type<unknown>; useValue: object } => ({
      provide,
      useValue: {},
    })),
  });

  for (const token of tokens) {
    builder.overrideGuard(token).useValue({});
  }

  const module = await builder.compile();
  const app = module.createNestApplication();

  try {
    // No init/listen: no controller methods or infrastructure lifecycle hooks run.
    return createOpenApiDocument(app);
  } finally {
    await app.close();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const output = resolve(process.argv[2] ?? 'openapi.json');
  const temporary = `${output}.${process.pid}.tmp`;

  try {
    const document = await exportOpenApiDocument();

    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`);
    await rename(temporary, output);
  } catch (error) {
    // A failed export must not leave a previous snapshot available to downstream generation.
    await rm(temporary, { force: true });
    await rm(output, { force: true });

    throw error;
  }
}
