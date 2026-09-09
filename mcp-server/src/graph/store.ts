/**
 * Graph and vector persistence.
 *
 * Two files per Figma file: the graph as JSON, and the embeddings as a raw
 * Float32 buffer alongside it. Vectors do not belong in JSON — a thousand
 * 768-dimension rows is four megabytes of binary that becomes six of base64 and
 * takes far longer to parse than to read.
 *
 * Both live under CLAUDE_PLUGIN_DATA with the design-system cache, for the same
 * reason: they are derived from a Figma file, not from the repository.
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { ScreenRecord } from './types.js';

export const GRAPH_SCHEMA_VERSION = 1;

function dataRoot(): string {
  const configured = process.env.FIGMA_FORGE_DATA_DIR;
  if (configured && configured.trim() && !configured.includes('${')) return resolve(configured);
  return join(homedir(), '.figma-forge');
}

function slug(value: string): string {
  return (value || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
}

export interface ComponentUsage {
  key: string;
  name: string;
  instances: number;
  screens: number;
}

export interface StoredGraph {
  schemaVersion: number;
  fileId: string;
  documentName: string;
  builtAt: number;
  /** Pages covered so far; a partial build lists fewer than totalPages. */
  pages: { id: string; name: string; index: number; screens: number }[];
  totalPages: number;
  complete: boolean;
  screens: ScreenRecord[];
  components: ComponentUsage[];
  embedding?: {
    model: string;
    dimensions: number;
    /** Screen ids in the same order as the vector rows. */
    order: string[];
    builtAt: number;
  };
}

function graphPath(fileId: string): string {
  return join(dataRoot(), 'graph', `${slug(fileId)}.json`);
}

function vectorPath(fileId: string): string {
  return join(dataRoot(), 'graph', `${slug(fileId)}.vec`);
}

export async function saveGraph(graph: StoredGraph): Promise<void> {
  await mkdir(join(dataRoot(), 'graph'), { recursive: true });
  await writeFile(graphPath(graph.fileId), JSON.stringify(graph), 'utf8');
}

export async function loadGraph(fileId: string): Promise<StoredGraph | null> {
  try {
    const graph = JSON.parse(await readFile(graphPath(fileId), 'utf8')) as StoredGraph;
    return graph.schemaVersion === GRAPH_SCHEMA_VERSION ? graph : null;
  } catch {
    return null;
  }
}

export async function saveVectors(fileId: string, vectors: Float32Array[]): Promise<void> {
  await mkdir(join(dataRoot(), 'graph'), { recursive: true });
  if (!vectors.length) {
    await rm(vectorPath(fileId), { force: true });
    return;
  }
  const dimensions = vectors[0].length;
  const flat = new Float32Array(vectors.length * dimensions);
  vectors.forEach((vector, index) => flat.set(vector, index * dimensions));
  await writeFile(vectorPath(fileId), Buffer.from(flat.buffer, flat.byteOffset, flat.byteLength));
}

export async function loadVectors(fileId: string, dimensions: number): Promise<Float32Array[]> {
  try {
    const buffer = await readFile(vectorPath(fileId));
    // Buffer may not be 4-byte aligned for a Float32Array view; copy when it is not.
    const aligned =
      buffer.byteOffset % 4 === 0
        ? new Float32Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.byteLength / 4))
        : new Float32Array(new Uint8Array(buffer).buffer);

    const rows: Float32Array[] = [];
    for (let offset = 0; offset + dimensions <= aligned.length; offset += dimensions) {
      rows.push(aligned.subarray(offset, offset + dimensions));
    }
    return rows;
  } catch {
    return [];
  }
}

export async function clearGraph(fileId: string): Promise<void> {
  await rm(graphPath(fileId), { force: true });
  await rm(vectorPath(fileId), { force: true });
}

export function graphDirectory(): string {
  return join(dataRoot(), 'graph');
}
