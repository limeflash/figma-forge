/**
 * Recovery.
 *
 * The MCP server owns the durable journal; this command is the hand that applies
 * it. Recovery is always partial-tolerant — a node someone has since edited or
 * deleted should not stop the other twenty from being restored — so the result
 * enumerates exactly what it could not touch.
 */

import { summarizeNode, safe } from '../serialize';
import { DATA_KEYS, JournalEntry, QUARANTINE_PAGE, errorMessage, rollback } from '../journal';

type AnyNode = BaseNode & { children?: readonly SceneNode[] };

export interface RecoverParams {
  action?: 'rollback' | 'restore_quarantine' | 'purge_quarantine' | 'list_operation';
  journal?: JournalEntry[];
  operationId?: string;
  nodeIds?: string[];
}

async function quarantinePage(): Promise<PageNode | null> {
  for (const page of figma.root.children) {
    if (page.name === QUARANTINE_PAGE) {
      await page.loadAsync();
      return page;
    }
  }
  return null;
}

export async function recover(params: RecoverParams): Promise<unknown> {
  switch (params.action ?? 'rollback') {
    case 'rollback': {
      if (!Array.isArray(params.journal) || !params.journal.length) {
        throw new Error('rollback needs the `journal` array recorded by the failed operation.');
      }
      const result = await rollback(params.journal);
      return {
        ...result,
        ok: result.failed.length === 0,
        note:
          result.failed.length === 0
            ? 'All journalled changes were reversed.'
            : 'Some inverses failed; the listed nodes still hold the change and need a human look.',
      };
    }

    case 'restore_quarantine': {
      const page = await quarantinePage();
      if (!page) return { restored: [], note: 'No quarantine page exists in this document.' };

      const wanted = params.nodeIds ? new Set(params.nodeIds) : null;
      const restored: string[] = [];
      const failed: { nodeId: string; error: string }[] = [];

      for (const node of [...page.children]) {
        if (wanted && !wanted.has(node.id)) continue;
        const raw = safe(() => node.getPluginData(DATA_KEYS.quarantinedFrom));
        if (!raw) continue;
        try {
          const origin = JSON.parse(raw) as { parentId: string; index: number };
          const parent = (await figma.getNodeByIdAsync(origin.parentId)) as (BaseNode & ChildrenMixin) | null;
          if (!parent || !('insertChild' in parent)) {
            failed.push({ nodeId: node.id, error: `original parent ${origin.parentId} is gone` });
            continue;
          }
          parent.insertChild(Math.min(origin.index, parent.children.length), node);
          node.setPluginData(DATA_KEYS.quarantinedFrom, '');
          restored.push(node.id);
        } catch (error) {
          failed.push({ nodeId: node.id, error: errorMessage(error) });
        }
      }
      return { restored, failed };
    }

    case 'purge_quarantine': {
      const page = await quarantinePage();
      if (!page) return { purged: 0 };
      const wanted = params.nodeIds ? new Set(params.nodeIds) : null;
      let purged = 0;
      for (const node of [...page.children]) {
        if (wanted && !wanted.has(node.id)) continue;
        if (params.operationId) {
          const owner = safe(() => node.getPluginData(DATA_KEYS.operation));
          if (owner !== params.operationId) continue;
        }
        node.remove();
        purged++;
      }
      return { purged };
    }

    case 'list_operation': {
      await figma.loadAllPagesAsync();
      const tagged = figma.root.findAll((node) => {
        const value = safe(() => node.getPluginData(DATA_KEYS.operation));
        return !!value && (!params.operationId || value === params.operationId);
      });
      const nodes = [];
      for (const node of tagged.slice(0, 200)) {
        nodes.push({
          ...(await summarizeNode(node as AnyNode, { depth: 0 })),
          operationId: safe(() => node.getPluginData(DATA_KEYS.operation)),
          createdByOperation: safe(() => node.getPluginData(DATA_KEYS.createdBy)) || undefined,
        });
      }
      return { count: tagged.length, nodes };
    }

    default:
      throw new Error(`Unknown recover action "${params.action}".`);
  }
}
