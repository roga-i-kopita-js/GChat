const functionTypes = new Set([
  'ArrowFunctionExpression',
  'FunctionExpression',
  'FunctionDeclaration',
]);

export default {
  meta: { name: 'gchat' },
  rules: {
    'no-await-call-member': {
      meta: {
        type: 'suggestion',
        docs: { description: 'Require destructuring to access properties of awaited results.' },
        schema: [],
        messages: {
          awaitFirst:
            'Use destructuring to read awaited result properties: const { property } = await operation();',
        },
      },
      create(context) {
        function unwrap(expression) {
          let value = expression;

          while (
            value &&
            (value.type === 'ChainExpression' ||
              value.type === 'TSAsExpression' ||
              value.type === 'TSTypeAssertion' ||
              value.type === 'TSNonNullExpression' ||
              value.type === 'TSSatisfiesExpression')
          ) {
            value = value.expression;
          }

          return value;
        }

        function awaitedResult(expression, seen = new Set()) {
          const value = unwrap(expression);

          if (!value) {
            return false;
          }

          if (value.type === 'AwaitExpression') {
            return true;
          }

          if (value.type !== 'Identifier') {
            return false;
          }

          for (let scope = context.sourceCode.getScope(value); scope; scope = scope.upper) {
            const variable = scope.variables.find((entry) => entry.name === value.name);

            if (!variable) {
              continue;
            }

            if (seen.has(variable)) {
              return false;
            }

            seen.add(variable);

            return variable.defs.some((definition) => {
              const declaration = definition.node;

              return (
                declaration.type === 'VariableDeclarator' &&
                declaration.id.type === 'Identifier' &&
                declaration.parent.kind === 'const' &&
                awaitedResult(declaration.init, seen)
              );
            });
          }

          return false;
        }

        return {
          MemberExpression(node) {
            if (awaitedResult(node.object)) {
              context.report({ node, messageId: 'awaitFirst' });
            }
          },
          AwaitExpression(node) {
            let current = node.argument;

            while (current) {
              if (current.type === 'MemberExpression') {
                let object = current.object;

                while (
                  object.type === 'ChainExpression' ||
                  object.type === 'TSAsExpression' ||
                  object.type === 'TSTypeAssertion' ||
                  object.type === 'TSNonNullExpression' ||
                  object.type === 'TSSatisfiesExpression'
                ) {
                  object = object.expression;
                }

                if (object.type === 'CallExpression' || object.type === 'NewExpression') {
                  context.report({ node: current, messageId: 'awaitFirst' });

                  return;
                }

                current = object;
              } else if (
                current.type === 'ChainExpression' ||
                current.type === 'TSAsExpression' ||
                current.type === 'TSTypeAssertion' ||
                current.type === 'TSNonNullExpression' ||
                current.type === 'TSSatisfiesExpression'
              ) {
                current = current.expression;
              } else {
                return;
              }
            }
          },
        };
      },
    },
    'no-promise-chains': {
      meta: {
        type: 'suggestion',
        docs: { description: 'Require async/await instead of Promise handler methods.' },
        schema: [],
        messages: {
          useAwait: 'Use async/await and try/catch/finally instead of Promise handler methods.',
        },
      },
      create(context) {
        const handlers = new Set(['then', 'catch', 'finally']);

        return {
          MemberExpression(node) {
            let name;

            if (!node.computed && node.property.type === 'Identifier') {
              name = node.property.name;
            } else if (node.computed && node.property.type === 'Literal') {
              name = node.property.value;
            } else if (
              node.computed &&
              node.property.type === 'TemplateLiteral' &&
              node.property.expressions.length === 0
            ) {
              name = node.property.quasis[0].value.cooked;
            }

            if (handlers.has(name)) {
              context.report({ node, messageId: 'useAwait' });
            }
          },
        };
      },
    },
    'no-await-in-object': {
      meta: {
        type: 'suggestion',
        docs: { description: 'Disallow await while constructing an object literal.' },
        schema: [],
        messages: {
          extractAwait: 'Await the result in a separate variable before constructing the object.',
        },
      },
      create(context) {
        return {
          AwaitExpression(node) {
            for (let parent = node.parent; parent; parent = parent.parent) {
              if (functionTypes.has(parent.type)) {
                return;
              }

              if (parent.type === 'ObjectExpression') {
                context.report({ node, messageId: 'extractAwait' });

                return;
              }
            }
          },
        };
      },
    },
  },
};
