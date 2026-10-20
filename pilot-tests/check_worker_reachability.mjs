// Inspect the emitted Cloudflare artifact, not npm's installation classification.
import { createRequire, builtinModules } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const checkout = resolve(process.argv[2] || '.pilot-mailflare');
const require = createRequire(join(checkout, 'package.json'));
const { init, parse } = require('es-module-lexer');
await init;
const root = join(checkout, 'dist/server');
const denied = /(?:^|[/\\])(?:braces|micromatch|fast-glob|vite-plugin-dynamic-import|vite-plugin-commonjs|@next[/\\]eslint-plugin-next)(?:[/\\]|$)/;
assert.deepEqual(JSON.parse(readFileSync(join(root, 'vinext-externals.json'))), []);
const files = readdirSync(root, { recursive: true, withFileTypes: true })
  .filter(x => x.isFile()).map(x => join(x.parentPath, x.name)).sort();
const hash = createHash('sha256');
let scripts = 0, maps = 0, sourceCount = 0;
const unmapped = [], dynamic = [], bare = new Set();
for (const file of files) {
  const name = relative(root, file).replaceAll('\\', '/');
  const bytes = readFileSync(file);
  hash.update(name).update('\0').update(bytes).update('\0');
  if (file.endsWith('.map')) {
    maps++;
    const map = JSON.parse(bytes);
    assert.ok(Array.isArray(map.sources), `Missing sources: ${name}`);
    for (const source of map.sources) {
      sourceCount++;
      assert.ok(!denied.test(source), `Forbidden bundled dependency: ${source}`);
    }
  }
  if (!file.endsWith('.js')) continue;
  scripts++;
  const code = bytes.toString();
  // Rollup keeps module provenance in comments; also check literal external imports.
  assert.ok(!/node_modules[/\\](?:braces|micromatch|fast-glob)[/\\]/.test(code), name);
  if (!code.includes('sourceMappingURL=')) unmapped.push(name);
  for (const imp of parse(code)[0]) {
    if (imp.type === 'import-meta') continue;
    assert.ok(typeof imp.start === 'number' && typeof imp.end === 'number', 'Unknown lexer API');
    if (imp.specifier == null) {
      dynamic.push({ file: name, expression: code.slice(imp.start, imp.end).slice(0, 300) });
      continue;
    }
    assert.ok(!denied.test(imp.specifier), `Forbidden import: ${imp.specifier}`);
    if (!imp.specifier.startsWith('.') && !imp.specifier.startsWith('/')) {
      bare.add(imp.specifier);
      assert.ok(builtinModules.includes(imp.specifier) || /^(?:node:|cloudflare:|workerd:)/.test(imp.specifier), `Unbundled package: ${imp.specifier}`);
    }
  }
}
assert.ok(scripts > 0 && maps > 0 && sourceCount > 0);
// Nonliteral imports require a human review; never silently call this complete.
console.log(JSON.stringify({
  artifact_sha256: hash.digest('hex'), scripts, maps, mapped_sources: sourceCount,
  forbidden_dependencies: 0, externals: [...bare].sort(),
  unmapped_scripts: unmapped, nonliteral_imports: dynamic,
  conclusion: dynamic.length ? 'review-nonliteral-imports' : 'excluded-from-worker-artifact',
}, null, 2));
