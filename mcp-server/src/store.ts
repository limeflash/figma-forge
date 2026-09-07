/**
 * Durable state: design-system index cache, write journals, session pairing.
 *
 * All of it lives under CLAUDE_PLUGIN_DATA, never the project directory. A
 * derived Figma index in the repo would conflict on every branch switch, leak
 * file metadata into commits, and go stale independently of the Figma file it
 * describes. The project directory is for things a human wrote and reviews.
 *
 * Journals are the exception that proves the rule: they must outlive both the
 * MCP process and the Figma tab, because their entire job is to still be there
 * after something went wrong.
 */

import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const INDEX_SCHEMA_VERSION = 1;

/** Library catalogs drift as colleagues publish; everything else is event-driven. */
export const LIBRARY_TTL_MS = 15 * 60 * 1000;

function dataRoot(): string {
  const configured = process.env.FIGMA_FORGE_DATA_DIR;
  if (configured && configured.trim() && !configured.includes('${')) return resolve(configured);
  return join(homedir(), '.figma-forge');
}

/** File keys are opaque strings from Figma; never let one become a path escape. */
function slug(value: string): string {
  return (value || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
}

async function ensureDir(path: string): Promise<string> {
  await mkdir(path, { recursive: true });
  return path;
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value, null, 2), 'utf8');
}

/* ------------------------------------------------------------------ *
 * Design-system index cache
 * ------------------------------------------------------------------ */

export interface CachedIndex<T = unknown> {
  schemaVersion: number;
  pluginVersion: string;
  fileKey: string;
  scope: string;
  builtAt: number;
  /** Node ids marked dirty by writes since the index was built. */
  dirtyNodeIds: string[];
  index: T;
}

function indexPath(fileKey: string, scope: string): string {
  return join(dataRoot(), 'index', `${slug(fileKey)}--${slug(scope)}.json`);
}

export async function readIndex<T>(fileKey: string, scope: string, pluginVersion: string): Promise<CachedIndex<T> | null> {
  const cached = await readJson<CachedIndex<T>>(indexPath(fileKey, scope));
  if (!cached) return null;
  // A schema or plugin bump changes what the rows mean, so the old file is not
  // stale — it is wrong. Drop it rather than trying to migrate.
  if (cached.schemaVersion !== INDEX_SCHEMA_VERSION || cached.pluginVersion !== pluginVersion) return null;
  return cached;
}

export async function writeIndex<T>(fileKey: string, scope: string, pluginVersion: string, index: T): Promise<CachedIndex<T>> {
  await ensureDir(join(dataRoot(), 'index'));
  const record: CachedIndex<T> = {
    schemaVersion: INDEX_SCHEMA_VERSION,
    pluginVersion,
    fileKey,
    scope,
    builtAt: Date.now(),
    dirtyNodeIds: [],
    index,
  };
  await writeJson(indexPath(fileKey, scope), record);
  return record;
}

/** Marks nodes a write touched so the next read knows what it cannot trust. */
export async function markDirty(fileKey: string, scope: string, nodeIds: string[]): Promise<void> {
  const path = indexPath(fileKey, scope);
  const cached = await readJson<CachedIndex>(path);
  if (!cached) return;
  const merged = new Set([...(cached.dirtyNodeIds ?? []), ...nodeIds]);
  cached.dirtyNodeIds = [...merged].slice(0, 5000);
  await writeJson(path, cached);
}

export async function clearIndex(fileKey: string, scope?: string): Promise<number> {
  const dir = join(dataRoot(), 'index');
  let removed = 0;
  try {
    for (const name of await readdir(dir)) {
      if (!name.startsWith(`${slug(fileKey)}--`)) continue;
      if (scope && name !== `${slug(fileKey)}--${slug(scope)}.json`) continue;
      await rm(join(dir, name), { force: true });
      removed++;
    }
  } catch {
    /* nothing cached yet */
  }
  return removed;
}

/* ------------------------------------------------------------------ *
 * Write journals
 * ------------------------------------------------------------------ */

export interface StoredJournal {
  operationId: string;
  channel: string;
  fileKey: string | null;
  description?: string;
  createdAt: number;
  status: 'applied' | 'failed' | 'rolled_back' | 'recovered';
  error?: string;
  created: string[];
  modified: string[];
  quarantined: string[];
  entries: unknown[];
}

function journalPath(operationId: string): string {
  return join(dataRoot(), 'journals', `${slug(operationId)}.json`);
}

export async function writeJournal(journal: StoredJournal): Promise<string> {
  await ensureDir(join(dataRoot(), 'journals'));
  const path = journalPath(journal.operationId);
  await writeJson(path, journal);
  return path;
}

export async function readJournal(operationId: string): Promise<StoredJournal | null> {
  return await readJson<StoredJournal>(journalPath(operationId));
}

export async function listJournals(limit = 20): Promise<StoredJournal[]> {
  const dir = join(dataRoot(), 'journals');
  const out: StoredJournal[] = [];
  try {
    for (const name of await readdir(dir)) {
      if (!name.endsWith('.json')) continue;
      const journal = await readJson<StoredJournal>(join(dir, name));
      if (journal) out.push(journal);
    }
  } catch {
    return [];
  }
  return out.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
}

/** The operation `/figma:recover` means when the user does not name one. */
export async function latestRecoverable(): Promise<StoredJournal | null> {
  const journals = await listJournals(50);
  return journals.find((journal) => journal.status === 'failed') ?? journals[0] ?? null;
}

export async function updateJournalStatus(
  operationId: string,
  status: StoredJournal['status'],
  error?: string
): Promise<void> {
  const journal = await readJournal(operationId);
  if (!journal) return;
  journal.status = status;
  if (error) journal.error = error;
  await writeJournal(journal);
}

/* ------------------------------------------------------------------ *
 * Session pairing
 * ------------------------------------------------------------------ */

export interface StoredSession {
  channel: string;
  fileKey: string | null;
  documentName?: string;
  sessionId?: string;
  port: number;
  updatedAt: number;
}

function sessionPath(channel: string): string {
  return join(dataRoot(), 'sessions', `${slug(channel)}.json`);
}

export async function writeSession(session: StoredSession): Promise<void> {
  await ensureDir(join(dataRoot(), 'sessions'));
  await writeJson(sessionPath(session.channel), session);
}

export async function readSession(channel: string): Promise<StoredSession | null> {
  return await readJson<StoredSession>(sessionPath(channel));
}

export function dataDirectory(): string {
  return dataRoot();
}
