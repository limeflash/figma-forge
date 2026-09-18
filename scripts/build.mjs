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

/**
 * `import source from 'page-script:collect'` yields the in-page collector as a
 * string. It runs inside the rendered page, not in Node, so it is bundled on
 * its own — as a browser IIFE with DOM types — and embedded as text.
 */
const pageScripts = {
  name: 'page-scripts',
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^page-script:/ }, (args) => ({
      path: resolve(root, 'mcp-server/src/html/page', `${args.path.slice('page-script:'.length)}.ts`),
      namespace: 'page-script',
    }));
    pluginBuild.onLoad({ filter: /.*/, namespace: 'page-script' }, async (args) => {
      const result = await build({
        entryPoints: [args.path],
        bundle: true,
        write: false,
        format: 'iife',
        target: 'chrome110',
        platform: 'browser',
        legalComments: 'none',
      });
      return {
        contents: result.outputFiles[0].text,
        loader: 'text',
        watchFiles: [args.path, resolve(root, 'shared/html-import.ts')],
      };
    });
  },
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
      // Figma keeps a plugin's code for the life of a run, so a rebuild only
      // reaches it when the plugin is started again. The stamp says which
      // build is actually live.
      define: { __FF_BUILD__: JSON.stringify(new Date().toISOString()) },
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
      plugins: [pageScripts],
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
