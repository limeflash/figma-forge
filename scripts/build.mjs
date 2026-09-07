#!/usr/bin/env node
/**
 * One build for three very different targets.
 *
 * The Figma plugin bundle has to be a single self-contained IIFE, because the
 * sandbox has no module loader. The MCP server and the bridge are Node ESM, and
 * both are bundled with their dependencies: a Claude Code plugin is installed by
 * cloning a repo, with no npm install step, so `dist/` is a shipped artifact and
 * is committed on purpose.
 */

import { build, context } from 'esbuild';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');

/**
 * `ws` is CommonJS, and an ESM bundle has no `require`. esbuild's interop stub
 * defers to a real `require` if one is in scope, so the banner supplies one.
 */
const nodeBanner = {
  js: [
    '#!/usr/bin/env node',
    "import { createRequire as __ffCreateRequire } from 'node:module';",
    'const require = __ffCreateRequire(import.meta.url);',
  ].join('\n'),
};

const targets = [
  {
    name: 'figma-plugin',
    options: {
      entryPoints: [resolve(root, 'figma-plugin/src/code.ts')],
      outfile: resolve(root, 'figma-plugin/dist/code.js'),
      bundle: true,
      format: 'iife',
      // The sandbox is modern but not bleeding-edge; ES2020 keeps async/await
      // native while avoiding syntax it has historically choked on.
      target: 'es2020',
      platform: 'neutral',
      legalComments: 'none',
      logLevel: 'info',
    },
  },
  {
    name: 'mcp-server',
    options: {
      entryPoints: [resolve(root, 'mcp-server/src/index.ts')],
      outfile: resolve(root, 'mcp-server/dist/index.js'),
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node20',
      banner: nodeBanner,
      logLevel: 'info',
    },
  },
  {
    name: 'bridge',
    options: {
      entryPoints: [resolve(root, 'bridge/server.mjs')],
      outfile: resolve(root, 'mcp-server/dist/bridge.js'),
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node20',
      banner: nodeBanner,
      logLevel: 'info',
    },
  },
];

async function copyUi() {
  await mkdir(resolve(root, 'figma-plugin/dist'), { recursive: true });
  await cp(resolve(root, 'figma-plugin/src/ui.html'), resolve(root, 'figma-plugin/dist/ui.html'));
}

/** Keeps the version the plugin reports in step with the manifest. */
async function syncVersion() {
  const manifest = JSON.parse(await readFile(resolve(root, '.claude-plugin/plugin.json'), 'utf8'));
  const codePath = resolve(root, 'figma-plugin/src/code.ts');
  const source = await readFile(codePath, 'utf8');
  const next = source.replace(/const PLUGIN_VERSION = '[^']*';/, `const PLUGIN_VERSION = '${manifest.version}';`);
  if (next !== source) await writeFile(codePath, next);
}

await syncVersion();

if (watch) {
  await copyUi();
  for (const target of targets) {
    const ctx = await context(target.options);
    await ctx.watch();
    console.log(`watching ${target.name}`);
  }
} else {
  await Promise.all(targets.map((target) => build(target.options)));
  await copyUi();
  console.log('build complete');
}
