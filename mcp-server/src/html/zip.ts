/**
 * A small zip reader.
 *
 * Claude Code installs this plugin by cloning it, with no install step, so a
 * dependency would have to be bundled — and shelling out to `unzip` fails on
 * machines without it. Reading a zip is a central directory walk plus
 * `inflateRaw`, which Node already has.
 *
 * Names are the fiddly part. Archives made on macOS and Windows routinely store
 * UTF-8 names without setting the flag that says so, and Russian Windows tools
 * use CP866: `unzip -l` on the user's own exports prints mojibake for exactly
 * that reason. So the flag is a hint, not the answer.
 */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, sep } from 'node:path';
import { inflateRawSync } from 'node:zlib';

const EOCD = 0x06054b50;
const ZIP64_EOCD = 0x06064b50;
const ZIP64_LOCATOR = 0x07064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ENTRIES = 50_000;

export interface ZipEntry {
  name: string;
  directory: boolean;
  method: number;
  encrypted: boolean;
  compressedSize: number;
  size: number;
  offset: number;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });
const cp866 = new TextDecoder('ibm866');

function decodeName(raw: Buffer, flagged: boolean, unicodeExtra: string | null): string {
  if (unicodeExtra) return unicodeExtra;
  if (flagged) return raw.toString('utf8');
  // Pure ASCII decodes the same in every candidate encoding.
  try {
    return utf8.decode(raw);
  } catch {
    return cp866.decode(raw);
  }
}

function findEndOfCentralDirectory(data: Buffer): number {
  const floor = Math.max(0, data.length - 65_557);
  for (let offset = data.length - 22; offset >= floor; offset--) {
    if (data.readUInt32LE(offset) === EOCD) return offset;
  }
  throw new Error('Not a zip archive: no end-of-central-directory record.');
}

function readExtras(extra: Buffer): Map<number, Buffer> {
  const out = new Map<number, Buffer>();
  let offset = 0;
  while (offset + 4 <= extra.length) {
    const id = extra.readUInt16LE(offset);
    const size = extra.readUInt16LE(offset + 2);
    out.set(id, extra.subarray(offset + 4, offset + 4 + size));
    offset += 4 + size;
  }
  return out;
}

export function listEntries(data: Buffer): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(data);
  let count = data.readUInt16LE(eocd + 10);
  let directoryOffset = data.readUInt32LE(eocd + 16);

  if (count === 0xffff || directoryOffset === 0xffffffff) {
    const locator = eocd - 20;
    if (locator >= 0 && data.readUInt32LE(locator) === ZIP64_LOCATOR) {
      const zip64 = Number(data.readBigUInt64LE(locator + 8));
      if (data.readUInt32LE(zip64) !== ZIP64_EOCD) throw new Error('Corrupt zip64 end-of-central-directory record.');
      count = Number(data.readBigUInt64LE(zip64 + 32));
      directoryOffset = Number(data.readBigUInt64LE(zip64 + 48));
    }
  }
  if (count > MAX_ENTRIES) throw new Error(`The archive has ${count} entries; the limit is ${MAX_ENTRIES}.`);

  const entries: ZipEntry[] = [];
  let offset = directoryOffset;
  for (let index = 0; index < count; index++) {
    if (data.readUInt32LE(offset) !== CENTRAL) throw new Error(`Corrupt central directory at entry ${index}.`);
    const flags = data.readUInt16LE(offset + 8);
    const method = data.readUInt16LE(offset + 10);
    let compressedSize = data.readUInt32LE(offset + 20);
    let size = data.readUInt32LE(offset + 24);
    const nameLength = data.readUInt16LE(offset + 28);
    const extraLength = data.readUInt16LE(offset + 30);
    const commentLength = data.readUInt16LE(offset + 32);
    let localOffset = data.readUInt32LE(offset + 42);

    const rawName = data.subarray(offset + 46, offset + 46 + nameLength);
    const extras = readExtras(data.subarray(offset + 46 + nameLength, offset + 46 + nameLength + extraLength));

    const zip64 = extras.get(0x0001);
    if (zip64) {
      let cursor = 0;
      if (size === 0xffffffff) { size = Number(zip64.readBigUInt64LE(cursor)); cursor += 8; }
      if (compressedSize === 0xffffffff) { compressedSize = Number(zip64.readBigUInt64LE(cursor)); cursor += 8; }
      if (localOffset === 0xffffffff) { localOffset = Number(zip64.readBigUInt64LE(cursor)); }
    }

    // Info-ZIP Unicode Path: version byte, CRC of the raw name, then UTF-8.
    const unicode = extras.get(0x7075);
    const unicodeName = unicode && unicode.length > 5 && unicode[0] === 1 ? unicode.subarray(5).toString('utf8') : null;

    const name = decodeName(rawName, (flags & 0x0800) !== 0, unicodeName);
    entries.push({
      name,
      directory: name.endsWith('/'),
      method,
      encrypted: (flags & 0x0001) !== 0,
      compressedSize,
      size,
      offset: localOffset,
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function readEntry(data: Buffer, entry: ZipEntry): Buffer {
  if (data.readUInt32LE(entry.offset) !== LOCAL) throw new Error(`Corrupt local header for ${entry.name}.`);
  const nameLength = data.readUInt16LE(entry.offset + 26);
  const extraLength = data.readUInt16LE(entry.offset + 28);
  const start = entry.offset + 30 + nameLength + extraLength;
  const body = data.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return Buffer.from(body);
  if (entry.method === 8) return inflateRawSync(body, { maxOutputLength: Math.max(entry.size, 1) });
  throw new Error(`${entry.name} uses compression method ${entry.method}, which is not supported.`);
}

/** Resolves an entry name to a path inside `root`, or null if it would escape. */
function safeTarget(root: string, name: string): string | null {
  const cleaned = name.replace(/\\/g, '/');
  if (cleaned.startsWith('/') || /^[a-zA-Z]:/.test(cleaned)) return null;
  const target = normalize(join(root, cleaned));
  return target === root || target.startsWith(root + sep) ? target : null;
}

/** Metadata the OS adds to archives; never part of a design. */
function isJunk(name: string): boolean {
  return name.startsWith('__MACOSX/') || /(^|\/)\.DS_Store$/.test(name) || /(^|\/)Thumbs\.db$/i.test(name);
}

export interface ExtractResult {
  files: number;
  bytes: number;
  skipped: { name: string; reason: string }[];
}

export async function extractZip(archivePath: string, destination: string): Promise<ExtractResult> {
  const info = await stat(archivePath);
  if (info.size > MAX_ARCHIVE_BYTES) {
    throw new Error(`${archivePath} is ${Math.round(info.size / 1048576)} MB; archives over 1 GB are not supported.`);
  }
  const data = await readFile(archivePath);
  const root = normalize(destination);
  await mkdir(root, { recursive: true });

  const result: ExtractResult = { files: 0, bytes: 0, skipped: [] };
  for (const entry of listEntries(data)) {
    if (entry.directory || isJunk(entry.name)) continue;
    if (entry.encrypted) {
      result.skipped.push({ name: entry.name, reason: 'encrypted' });
      continue;
    }
    const target = safeTarget(root, entry.name);
    if (!target) {
      result.skipped.push({ name: entry.name, reason: 'path escapes the archive' });
      continue;
    }
    if (result.bytes + entry.size > MAX_TOTAL_BYTES) {
      throw new Error('The archive expands to more than 2 GB.');
    }
    try {
      const body = readEntry(data, entry);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, body);
      result.files++;
      result.bytes += body.length;
    } catch (error) {
      result.skipped.push({ name: entry.name, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}
