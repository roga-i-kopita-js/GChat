export function validateSchema(schema) {
  const ids = new Set();
  const methods = new Set(['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace']);
  const operations = [];
  const visit = (value) => {
    if (!value || typeof value !== 'object') {
      return;
    }

    if (value.$ref) {
      if (!value.$ref.startsWith('#/')) {
        throw new Error(`Only local refs are supported: ${value.$ref}`);
      }

      const target = value.$ref
        .slice(2)
        .split('/')
        .reduce((node, key) => node?.[key.replaceAll('~1', '/').replaceAll('~0', '~')], schema);

      if (target === undefined) {
        throw new Error(`Unresolved ref: ${value.$ref}`);
      }
    }

    for (const child of Object.values(value)) {
      visit(child);
    }
  };

  visit(schema);

  for (const [path, item] of Object.entries(schema.paths ?? {})) {
    for (const [method, operation] of Object.entries(item)) {
      if (!methods.has(method)) {
        continue;
      }

      const id = operation.operationId;

      if (!/^[a-z][a-zA-Z0-9]*$/.test(id ?? '') || ids.has(id)) {
        throw new Error(`Missing, invalid or duplicate operationId: ${method} ${path}`);
      }

      if (['constructor', 'request', 'transport'].includes(id)) {
        throw new Error(`Reserved operationId: ${id}`);
      }

      ids.add(id);
      const parameters = [...(item.parameters ?? []), ...(operation.parameters ?? [])];

      if (
        parameters.some(
          (p) =>
            p.$ref ||
            !p.schema ||
            !['path', 'query'].includes(p.in) ||
            (p.style && p.style !== (p.in === 'path' ? 'simple' : 'form')) ||
            !['string', 'number', 'integer', 'boolean', 'array'].includes(p.schema.type) ||
            (p.schema.type === 'array' &&
              (p.in === 'path' ||
                !['string', 'number', 'integer', 'boolean'].includes(p.schema.items?.type))),
        )
      ) {
        throw new Error(`Unsupported or incomplete parameters: ${id}`);
      }

      for (const name of path.matchAll(/\{([^}]+)\}/g)) {
        if (!parameters.some((p) => p.in === 'path' && p.name === name[1] && p.required)) {
          throw new Error(`Missing path parameter: ${id}/${name[1]}`);
        }
      }

      const requireJson = (content) => {
        if (!content?.['application/json']?.schema) {
          throw new Error(`Missing JSON schema: ${id}`);
        }
      };

      if (operation.requestBody) {
        requireJson(operation.requestBody.content);
      }

      const success = Object.entries(operation.responses ?? {}).filter(([status]) =>
        /^2\d\d$/.test(status),
      );

      if (!success.length) {
        throw new Error(`Missing successful response: ${id}`);
      }

      for (const [, response] of success) {
        if (response.content) {
          requireJson(response.content);
        }
      }

      const security = operation.security ?? schema.security ?? [];

      if (
        security.some((s) =>
          Object.keys(s).some(
            (name) => schema.components?.securitySchemes?.[name]?.scheme !== 'bearer',
          ),
        )
      ) {
        throw new Error(`Unsupported security: ${id}`);
      }

      operations.push({
        path,
        method,
        operation,
        parameters,
        protected: security.length > 0 && !security.some((s) => Object.keys(s).length === 0),
      });
    }
  }

  if (!operations.length) {
    throw new Error('No HTTP operations');
  }

  return operations;
}
