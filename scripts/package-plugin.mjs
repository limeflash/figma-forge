#!/usr/bin/env node
/**
 * Packs the Figma plugin into the archive a release ships.
 *
 * Figma installs a development plugin from a manifest on disk, and the manifest
 * points at `dist/code.js` and `dist/ui.html` beside it. Those three files are
 * the whole plugin: no npm install, no build step on the other machine. The zip
 * keeps them under one folder so unzipping does not scatter files into whatever
 * directory the download landed in.
 */

import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(await readFile(resolve(root, '.claude-plugin/plugin.json'), 'utf8'));
const folder = 'figma-forge-plugin';
const outDir = resolve(root, 'release');
const outFile = join(outDir, `${folder}-${version}.zip`);

if (!process.argv.includes('--no-build')) {
  execFileSync(process.execPath, [resolve(root, 'scripts/build.mjs')], { cwd: root, stdio: 'inherit' });
}

const INSTALL = `Figma Forge — Figma plugin ${version}

Install (any machine, no build step):

1. Unzip this archive anywhere you will not delete it. Figma reads the files
   from where they sit, so a Downloads folder you empty is a bad home.
2. In Figma: Plugins -> Development -> Import plugin from manifest...
3. Choose manifest.json from this folder.

The plugin is one half of Figma Forge. The other half runs in Claude Code:

    /plugin marketplace add limeflash/figma-forge
    /plugin install figma-forge
    /figma-forge:connect

That prints a port and a channel name. Open Plugins -> Development -> Figma
Forge in Figma, enter those two, press Connect.

The plugin talks to ws://localhost:3055 on your own machine and nowhere else.

https://github.com/limeflash/figma-forge
`;

const stage = await mkdtemp(join(tmpdir(), 'figma-forge-pack-'));
const dir = join(stage, folder);
await mkdir(join(dir, 'dist'), { recursive: true });
await cp(resolve(root, 'figma-plugin/manifest.json'), join(dir, 'manifest.json'));
await cp(resolve(root, 'figma-plugin/dist/code.js'), join(dir, 'dist/code.js'));
await cp(resolve(root, 'figma-plugin/dist/ui.html'), join(dir, 'dist/ui.html'));
await writeFile(join(dir, 'INSTALL.txt'), INSTALL);

await mkdir(outDir, { recursive: true });
await rm(outFile, { force: true });
try {
  execFileSync('zip', ['-qr', outFile, folder], { cwd: stage });
} catch (error) {
  if (error.code === 'ENOENT') throw new Error('`zip` is not on PATH; install it or package the folder by hand.');
  throw error;
}
await rm(stage, { recursive: true, force: true });

const { size } = await stat(outFile);
console.log(`${outFile}  ${(size / 1024).toFixed(0)} KB`);
