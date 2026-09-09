/**
 * Storybook importer.
 *
 * Deliberately not a converter. Turning arbitrary React into editable Figma
 * components produces something that is neither faithful nor maintainable, so
 * this reads Storybook's index and produces a *mapping*: which components exist
 * in code, what their stories are, and which Figma component each one
 * corresponds to. Stories are strong candidates for variant values, because a
 * story is usually exactly one state someone thought worth showing.
 *
 * What the mapping is for: enriching Figma components that already exist, and
 * making the gaps in both directions visible.
 */

import { readFile } from 'node:fs/promises';
import { hash } from './ir.js';

interface IndexEntry {
  type?: string;
  id: string;
  name: string;
  title: string;
  importPath?: string;
  tags?: string[];
}

export interface StorybookComponent {
  /** Storybook's `title`, e.g. `Components/Forms/Button`. */
  title: string;
  name: string;
  /**
   * Every plausible reading of the title as a component name. Storybook splits
   * titles on `/`, but Figma component names use `/` too — `Components/Card /
   * Surface` could be "Surface" nested under Card, or a component actually
   * called "Card / Surface". Rather than pick, offer both to the matcher.
   */
  nameCandidates: string[];
  importPath?: string;
  stories: string[];
  docsOnly: boolean;
  tags: string[];
  sourceId: string;
}

export interface StorybookIR {
  source: { kind: 'storybook'; path: string; hash: string; importedAt: number; version?: number };
  components: StorybookComponent[];
  warnings: string[];
}

export async function parseStorybook(path: string): Promise<StorybookIR> {
  const warnings: string[] = [];
  const raw = await readFile(path, 'utf8');

  let parsed: { v?: number; entries?: Record<string, IndexEntry>; stories?: Record<string, IndexEntry> };
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Storybook 7+ writes `entries`; 6.x wrote `stories`. Same shape inside.
  const entries = parsed.entries ?? parsed.stories;
  if (!entries || typeof entries !== 'object') {
    throw new Error(
      `${path} has no "entries" or "stories" object. Point at Storybook's generated ` +
        '`index.json` (or `stories.json`), not `main.js` or a story file.'
    );
  }

  const byTitle = new Map<string, StorybookComponent>();

  for (const entry of Object.values(entries)) {
    if (!entry || typeof entry.title !== 'string') continue;
    let component = byTitle.get(entry.title);
    if (!component) {
      const segments = entry.title.split('/').map((segment) => segment.trim()).filter(Boolean);
      component = {
        title: entry.title,
        name: segments[segments.length - 1] ?? entry.title,
        nameCandidates: candidateNames(segments),
        importPath: entry.importPath,
        stories: [],
        docsOnly: true,
        tags: [],
        sourceId: `storybook:${entry.title}`,
      };
      byTitle.set(entry.title, component);
    }
    if (entry.type === 'docs') continue;
    component.docsOnly = false;
    if (entry.name && !component.stories.includes(entry.name)) component.stories.push(entry.name);
    for (const tag of entry.tags ?? []) if (!component.tags.includes(tag)) component.tags.push(tag);
  }

  const components = [...byTitle.values()].sort((a, b) => a.title.localeCompare(b.title));
  if (!components.length) warnings.push('The index parsed but contained no components.');

  const docsOnly = components.filter((component) => component.docsOnly).length;
  if (docsOnly) warnings.push(`${docsOnly} entr${docsOnly === 1 ? 'y is' : 'ies are'} documentation-only, with no stories to read variants from.`);

  return {
    source: { kind: 'storybook', path, hash: hash(raw), importedAt: Date.now(), version: parsed.v },
    components,
    warnings,
  };
}

/** Last segment, then progressively more of the tail, longest tried first. */
function candidateNames(segments: string[]): string[] {
  const out: string[] = [];
  for (let take = Math.min(segments.length, 3); take >= 1; take--) {
    const joined = segments.slice(segments.length - take).join(' / ');
    if (!out.includes(joined)) out.push(joined);
  }
  return out;
}
