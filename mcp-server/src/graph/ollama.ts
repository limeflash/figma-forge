/**
 * Embedding provider backed by Ollama.
 *
 * Local, not cloud: Ollama Cloud hosts only generative models — there is no
 * embedding model in its catalogue — so `embeddinggemma` runs on the user's own
 * machine. That also happens to be the right call for this data, since a design
 * file's screen text never leaves the laptop.
 *
 * Everything here degrades rather than throws where it can. The graph and its
 * lexical search work with no Ollama installed at all; embeddings are the layer
 * that makes "экран оплаты" find a screen named "other profile", and their
 * absence should cost recall, not the feature.
 */

export const DEFAULT_MODEL = 'embeddinggemma';
export const DEFAULT_HOST = 'http://127.0.0.1:11434';

export interface OllamaStatus {
  reachable: boolean;
  host: string;
  version?: string;
  models: string[];
  hasModel: boolean;
  model: string;
  /** What the user should run, when something is missing. */
  remedy?: string;
}

function host(): string {
  const configured = process.env.FIGMA_FORGE_OLLAMA_HOST ?? process.env.OLLAMA_HOST;
  if (!configured || !configured.trim() || configured.includes('${')) return DEFAULT_HOST;
  const value = configured.trim();
  return /^https?:\/\//.test(value) ? value : `http://${value}`;
}

export function embeddingModel(): string {
  const configured = process.env.FIGMA_FORGE_EMBED_MODEL;
  return configured && configured.trim() && !configured.includes('${') ? configured.trim() : DEFAULT_MODEL;
}

export async function status(): Promise<OllamaStatus> {
  const base = host();
  const model = embeddingModel();
  const result: OllamaStatus = { reachable: false, host: base, models: [], hasModel: false, model };

  try {
    const version = await fetch(`${base}/api/version`, { signal: AbortSignal.timeout(2000) });
    if (version.ok) {
      result.reachable = true;
      result.version = ((await version.json()) as { version?: string }).version;
    }
  } catch {
    result.remedy =
      'Ollama is not running. Install it from https://ollama.com/download, then ' +
      `\`ollama pull ${model}\`. Graph search still works without it, using words only.`;
    return result;
  }

  try {
    const tags = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (tags.ok) {
      const body = (await tags.json()) as { models?: { name?: string }[] };
      result.models = (body.models ?? []).map((entry) => entry.name ?? '').filter(Boolean);
      // `ollama list` reports `embeddinggemma:latest` for a bare `embeddinggemma`.
      result.hasModel = result.models.some((name) => name === model || name.split(':')[0] === model.split(':')[0]);
    }
  } catch {
    /* the version probe already proved it is up */
  }

  if (!result.hasModel) result.remedy = `Run \`ollama pull ${model}\` to enable semantic search.`;
  return result;
}

/**
 * EmbeddingGemma is trained with task prefixes, and retrieval quality drops
 * measurably without them: documents and queries are embedded asymmetrically.
 */
export function documentPrompt(title: string, text: string): string {
  return `title: ${title || 'none'} | text: ${text}`;
}

export function queryPrompt(text: string): string {
  return `task: search result | query: ${text}`;
}

export class OllamaUnavailable extends Error {
  readonly remedy: string;
  constructor(message: string, remedy: string) {
    super(message);
    this.name = 'OllamaUnavailable';
    this.remedy = remedy;
  }
}

export interface EmbedOptions {
  /** Inputs per request. Large batches are faster but hold memory in Ollama. */
  batchSize?: number;
  timeoutMs?: number;
  onProgress?: (done: number, total: number) => void;
}

export async function embed(inputs: string[], options: EmbedOptions = {}): Promise<Float32Array[]> {
  if (!inputs.length) return [];

  const base = host();
  const model = embeddingModel();
  const batchSize = options.batchSize ?? 64;
  const out: Float32Array[] = [];

  for (let offset = 0; offset < inputs.length; offset += batchSize) {
    const batch = inputs.slice(offset, offset + batchSize);
    let response: Response;
    try {
      response = await fetch(`${base}/api/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, input: batch }),
        // Generous: a cold model load can take a while on first call.
        signal: AbortSignal.timeout(options.timeoutMs ?? 180_000),
      });
    } catch (error) {
      const state = await status();
      throw new OllamaUnavailable(
        `Could not reach Ollama at ${base}: ${error instanceof Error ? error.message : String(error)}`,
        state.remedy ?? 'Start Ollama and try again.'
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      if (/not found|pull it first/i.test(body)) {
        throw new OllamaUnavailable(`Model "${model}" is not installed.`, `Run \`ollama pull ${model}\`.`);
      }
      throw new OllamaUnavailable(`Ollama returned ${response.status}: ${body.slice(0, 200)}`, 'Check the Ollama logs.');
    }

    const body = (await response.json()) as { embeddings?: number[][] };
    if (!body.embeddings || body.embeddings.length !== batch.length) {
      throw new OllamaUnavailable(
        `Ollama returned ${body.embeddings?.length ?? 0} vectors for ${batch.length} inputs.`,
        'Try a smaller batch size.'
      );
    }

    for (const vector of body.embeddings) out.push(normalize(Float32Array.from(vector)));
    options.onProgress?.(Math.min(offset + batchSize, inputs.length), inputs.length);
  }

  return out;
}

/** Stored normalised, so cosine similarity is a plain dot product at query time. */
export function normalize(vector: Float32Array): Float32Array {
  let sum = 0;
  for (const value of vector) sum += value * value;
  const length = Math.sqrt(sum);
  if (!length) return vector;
  for (let i = 0; i < vector.length; i++) vector[i] /= length;
  return vector;
}

export function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) sum += a[i] * b[i];
  return sum;
}
