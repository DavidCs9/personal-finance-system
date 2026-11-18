import { normalizeEventTags, normalizeMerchantKey, resolveCategoryId, type MerchantCategoryRule } from '@finance/domain';
import type { SqlClient } from './projection.js';

type Change = { previous?: unknown; next?: unknown };
type ClassificationInput = {
  status: unknown;
  eventType: unknown;
  amount: { amountMinor: number; currency: unknown };
};

export const canClassifyMovement = ({ status, eventType, amount }: ClassificationInput): boolean =>
  status === 'accepted' && (eventType === 'card_purchase' || eventType === 'card_charge')
  && amount.currency === 'MXN' && amount.amountMinor > 0;

// These namespaces describe the purchase itself. Context tags stay specific to each movement.
export const isReusableClassificationTag = (tag: string): boolean =>
  tag.length <= 48 && /^(auto|tipo):[a-z0-9][a-z0-9_-]*$/.test(tag);

const MAX_FEEDBACK_ROWS = 200;

const ruleRows = async (client: SqlClient, merchantKey: string) => (await client.query(
  `SELECT r.id,r.merchant_key,r.pattern,r.category_id,r.source,r.updated_at
    FROM olbia.merchant_rules r
    LEFT JOIN olbia.category_lifecycle l ON l.category_id=r.category_id
    WHERE r.source<>'llm_residual' AND r.category_id IS NOT NULL AND l.archived IS DISTINCT FROM true
      AND (r.merchant_key=$1 OR (r.pattern<>'' AND strpos($1,r.pattern)>0))
    ORDER BY r.merchant_key COLLATE "C"`, [merchantKey],
)).rows.map(row => ({
  id: String(row.id), merchantKey: String(row.merchant_key), categoryId: String(row.category_id),
  pattern: typeof row.pattern === 'string' ? row.pattern : undefined,
  source: row.source as MerchantCategoryRule['source'], updatedAt: String(row.updated_at),
}));

const tagsIn = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((tag): tag is string => typeof tag === 'string' && isReusableClassificationTag(tag)) : [];

const feedbackRows = async (client: SqlClient, merchantKey: string) => {
  const token = merchantKey.split(' ').sort((a, b) => b.length - a.length)[0];
  // The token keeps the query narrow. Non-ASCII candidates also need the same JS normalization as the rule catalog.
  return (await client.query(
    `SELECT m.id,m.merchant_raw,m.category_id,r.id AS revision_id,r.operation_id,
      r.changes->'categoryId' AS category_change,r.changes->'tags' AS tag_change,
      COALESCE(l.archived,false) AS archived,
      (SELECT COALESCE(jsonb_agg(t.tag),'[]'::jsonb) FROM olbia.ledger_tags t WHERE t.movement_id=m.id) AS tags
    FROM olbia.ledger_revisions r
    JOIN olbia.ledger_movements m ON m.id=r.movement_id
    LEFT JOIN olbia.category_lifecycle l ON l.category_id=m.category_id
    LEFT JOIN olbia.ledger_bulk_operations op ON op.id=r.operation_id
    WHERE m.status='accepted' AND m.event_type IN ('card_purchase','card_charge')
      AND m.currency='MXN' AND m.amount_minor>0
      AND (m.merchant_raw ILIKE $1 OR octet_length(m.merchant_raw)<>length(m.merchant_raw))
      AND (
        (r.source IS NULL AND r.reason IN ('set_category','Tags actualizados desde la UI.'))
        OR (op.status='applied' AND r.source IN ('assistant_confirmed_bulk','assistant_chat_category_edit','assistant_chat_tag_edit'))
      )
      AND (r.changes->'categoryId' IS NOT NULL OR r.changes->'tags' IS NOT NULL)
    ORDER BY r.created_at DESC,r.id DESC LIMIT $2`, [`%${token}%`, MAX_FEEDBACK_ROWS + 1],
  )).rows;
};

export interface MerchantClassification {
  readonly category?: { readonly id: string; readonly source: 'rule' | 'history' };
  readonly tags: readonly string[];
  readonly currentCategoryReviewed: boolean;
  readonly currentRemovedTags: readonly string[];
}

export const classifyMerchant = async (client: SqlClient, merchantRaw: string, movementId?: string): Promise<MerchantClassification> => {
  const empty = { tags: [], currentCategoryReviewed: false, currentRemovedTags: [] };
  const merchantKey = normalizeMerchantKey(merchantRaw);
  if (!merchantKey) return empty;
  const rules = await ruleRows(client, merchantKey);
  const confirmedExact = rules.find(rule => rule.merchantKey === merchantKey && rule.source !== 'seed');
  const fromRule = (id: string) => ({ id, source: 'rule' as const });
  const rows = await feedbackRows(client, merchantKey);
  if (rows.length > MAX_FEEDBACK_ROWS) {
    return { ...empty, currentCategoryReviewed: movementId !== undefined,
      category: confirmedExact && fromRule(confirmedExact.categoryId) };
  }

  const categoryVotes = new Set<string | null>();
  const categoryActions = new Set<string>();
  const reviewedCategories = new Set<string>();
  const tagActions = new Map<string, Set<string>>();
  const removedTags = new Set<string>();
  const currentRemovedTags = new Set<string>();
  const reviewedTags = new Map<string, Set<string>>();

  for (const row of rows) {
    if (normalizeMerchantKey(String(row.merchant_raw)) !== merchantKey) continue;
    const id = String(row.id);
    const action = String(row.operation_id ?? row.revision_id);
    const categoryChange = row.category_change as Change | null;
    if (categoryChange && categoryChange.next === row.category_id && !reviewedCategories.has(id)) {
      reviewedCategories.add(id);
      if (id !== movementId) {
        categoryVotes.add(row.archived === true ? null : row.category_id as string | null);
        categoryActions.add(action);
      }
    }

    const tagChange = row.tag_change as Change | null;
    if (!tagChange) continue;
    const previous = tagsIn(tagChange.previous);
    const next = tagsIn(tagChange.next);
    const current = tagsIn(row.tags);
    const seen = reviewedTags.get(id) ?? new Set<string>();
    reviewedTags.set(id, seen);
    for (const tag of previous) {
      if (seen.has(tag) || next.includes(tag) || current.includes(tag)) continue;
      seen.add(tag);
      (id === movementId ? currentRemovedTags : removedTags).add(tag);
    }
    if (id === movementId) continue;
    for (const tag of next) {
      if (seen.has(tag) || previous.includes(tag) || !current.includes(tag)) continue;
      seen.add(tag);
      const actions = tagActions.get(tag) ?? new Set<string>();
      actions.add(action);
      tagActions.set(tag, actions);
    }
  }

  const observedCategory = categoryVotes.size === 1 ? [...categoryVotes][0] : undefined;
  const configured = resolveCategoryId(merchantKey, rules);
  const category = confirmedExact ? fromRule(confirmedExact.categoryId)
    : observedCategory && categoryActions.size >= 2 ? { id: observedCategory, source: 'history' as const }
    : configured && (!categoryVotes.size || observedCategory === configured) ? fromRule(configured)
    : undefined;

  // Keep the entire set within the existing Ledger tag constraint even for merchants with a long history.
  const repeated = [...tagActions].filter(([tag, actions]) => actions.size >= 2 && !removedTags.has(tag)).map(([tag]) => tag);
  return { category, tags: normalizeEventTags(repeated.sort().slice(0, 20)),
    currentCategoryReviewed: movementId !== undefined && reviewedCategories.has(movementId),
    currentRemovedTags: [...currentRemovedTags] };
};
