import type { INestApplication } from '@nestjs/common';
import type { OpenAPIObject } from '@nestjs/swagger';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

export function setupSwagger(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('GChat API')
    .setDescription('GChat backend HTTP API. Generated from controllers and DTOs.')
    .setVersion('0.0.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, config);

  SwaggerModule.setup('docs', app, document, {
    jsonDocumentUrl: '/docs-json',
    raw: ['json'],
    customSiteTitle: 'GChat API',
    swaggerOptions: { persistAuthorization: false },
  });

  return document;
}
