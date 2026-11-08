import type { INestApplication } from '@nestjs/common';
import { METHOD_METADATA } from '@nestjs/common/constants.js';
import { MetadataScanner, ModulesContainer } from '@nestjs/core';
import type { OpenAPIObject } from '@nestjs/swagger';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

export function createOpenApiDocument(app: INestApplication): OpenAPIObject {
  const ids = new Set<string>();
  const scanner = new MetadataScanner();

  for (const module of app.get(ModulesContainer).values()) {
    for (const { metatype } of module.controllers.values()) {
      if (!metatype) {
        continue;
      }

      for (const name of scanner.getAllMethodNames(metatype.prototype)) {
        const method = metatype.prototype[name];

        if (!Reflect.hasMetadata(METHOD_METADATA, method)) {
          continue;
        }

        const operation: { operationId?: string } =
          Reflect.getMetadata('swagger/apiOperation', method) ?? {};
        const id = operation.operationId;

        if (!id || !/^[a-z][a-zA-Z0-9]*$/.test(id) || ids.has(id)) {
          throw new Error(`Missing, invalid or duplicate operationId: ${metatype.name}.${name}`);
        }

        ids.add(id);
      }
    }
  }

  const config = new DocumentBuilder()
    .setTitle('GChat API')
    .setDescription('GChat backend HTTP API. Generated from controllers and DTOs.')
    .setVersion('0.0.0')
    .addBearerAuth()
    .build();

  return SwaggerModule.createDocument(app, config);
}

export function setupSwagger(app: INestApplication): OpenAPIObject {
  const document = createOpenApiDocument(app);

  SwaggerModule.setup('docs', app, document, {
    jsonDocumentUrl: '/docs-json',
    raw: ['json'],
    customSiteTitle: 'GChat API',
    swaggerOptions: { persistAuthorization: false },
  });

  return document;
}
