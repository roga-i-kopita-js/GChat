import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ignored = new Set([
  'node_modules',
  '.git',
  '.pnpm-store',
  'dist',
  'coverage',
  '.idea',
  'build',
  'DerivedData',
]);
const documents = new Map();
const failures = [];
const sections = [
  'Назначение и границы',
  'Публичный API',
  'Правила и инварианты',
  'Зависимости и регистрация',
  'Ошибки и частичное выполнение',
  'Конфигурация',
  'Критерии приёмки и проверки',
  'Открытые решения',
];

async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) {
      continue;
    }

    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      await collect(path);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      documents.set(path, await readFile(path, 'utf8'));
    }
  }
}

for (const name of ['README.md', 'AGENTS.md']) {
  const path = join(root, name);

  documents.set(path, await readFile(path, 'utf8'));
}

await collect(join(root, 'docs'));
await collect(join(root, 'applications'));

function withoutCode(text) {
  return text.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, '');
}
function anchors(text) {
  const counts = new Map();

  return new Set(
    [...withoutCode(text).matchAll(/^#{1,6}\s+(.+?)\s*#*$/gm)].map((match) => {
      const slug = match[1]
        .toLowerCase()
        .replace(/<[^>]+>/g, '')
        .replace(/[^\p{L}\p{N}\p{M}_\s-]/gu, '')
        .replace(/\s/g, '-');
      const count = counts.get(slug) ?? 0;

      counts.set(slug, count + 1);

      return count ? `${slug}-${count}` : slug;
    }),
  );
}
async function exists(path) {
  try {
    await stat(path);

    return true;
  } catch {
    return false;
  }
}
function fail(path, message) {
  failures.push(`${relative(root, path)}: ${message}`);
}

let modules = 0;

for (const [path, content] of documents) {
  const text = withoutCode(content);

  for (const match of text.matchAll(/\]\((<[^>]+>|[^\s)]+)(?:\s+"[^"]*")?\)/g)) {
    const target = match[1].replace(/^<|>$/g, '');

    if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(target)) {
      continue;
    }

    const [file, fragment] = target.split('#', 2);
    const destination = file ? resolve(dirname(path), decodeURIComponent(file)) : path;

    if (!(await exists(destination))) {
      fail(path, `missing link target: ${target}`);
      continue;
    }

    if (fragment && extname(destination) === '.md') {
      const body = documents.get(destination) ?? (await readFile(destination, 'utf8'));

      if (!anchors(body).has(decodeURIComponent(fragment))) {
        fail(path, `missing anchor: ${target}`);
      }
    }
  }

  const moduleFolder = join(root, 'docs/backend/modules') + '/';

  if (!path.startsWith(moduleFolder)) {
    continue;
  }

  const metadata = content.match(/^---\n([\s\S]*?)\n---\n/);

  if (!metadata) {
    fail(path, 'missing module metadata');
    continue;
  }

  const fields = Object.fromEntries(
    [...metadata[1].matchAll(/^(\w+):\s*(.+)$/gm)].map((m) => [m[1], m[2]]),
  );

  if (fields.doc_type === 'decision') {
    if (!['draft', 'accepted', 'deprecated'].includes(fields.decision_status)) {
      fail(path, 'invalid decision_status');
    }

    continue;
  }

  modules++;

  if (fields.doc_type !== 'module') {
    fail(path, 'doc_type must be module or decision');
  }

  if (!['draft', 'accepted', 'deprecated'].includes(fields.decision_status)) {
    fail(path, 'invalid decision_status');
  }

  if (!['absent', 'partial', 'implemented'].includes(fields.implementation_status)) {
    fail(path, 'invalid implementation_status');
  }

  if (!fields.source) {
    fail(path, 'missing source');
  } else if (fields.source !== 'null' && !(await exists(resolve(root, fields.source)))) {
    fail(path, `missing source path: ${fields.source}`);
  }

  if (fields.implementation_status === 'implemented' && fields.source === 'null') {
    fail(path, 'implemented module needs a source path');
  }

  let tests;

  try {
    tests = JSON.parse(fields.tests);
  } catch {
    fail(path, 'tests must be a JSON array of paths');
  }

  if (tests !== undefined) {
    if (!Array.isArray(tests) || tests.some((test) => typeof test !== 'string')) {
      fail(path, 'tests must contain only path strings');
    } else {
      for (const test of tests) {
        if (!(await exists(resolve(root, test)))) {
          fail(path, `missing test path: ${test}`);
        }
      }
    }
  }

  const headings = [...text.matchAll(/^## (.+)$/gm)].map((m) => m[1]);

  if (JSON.stringify(headings) !== JSON.stringify(sections)) {
    fail(path, 'module sections do not match module-template.md');
  }
}

if (failures.length) {
  process.stderr.write(failures.join('\n') + '\n');
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Documentation checked: ${documents.size} Markdown files, ${modules} module contracts.\n`,
  );
}
