'use server';

/**
 * Payer Intel Server Actions — thin binders assembling real deps (deps.ts) for the pure cores
 * (core.ts). The browser's ONLY data path (standing rule): search terms travel in these POST
 * bodies, never a URL. ⚠ `'use server'` files may export ONLY async functions — one non-function
 * export 500s every action on the page, silently, past the whole 5-command gate (memory:
 * use-server-export-kills-all-actions). Sync factories live in deps.ts for exactly that reason.
 *
 * Every action returns a typed union and never echoes an internal error to the client.
 */
import { requirePayerIntelPrincipal } from './gate';
import {
  clearPayerIntelHistoryCore,
  getPayerIntelBoardCore,
  getPayerIntelGridCore,
  runPayerIntelSearchCore,
  togglePayerIntelStarCore,
  watchPayerIntelSubjectCore,
  type PayerIntelToggleStarResult,
  type PayerIntelWatchResult,
} from './core';
import {
  clampPayerIntelWindowDays,
  type PayerIntelBoard,
  type PayerIntelEntityType,
  type PayerIntelGridCursor,
  type PayerIntelGridPage,
  type PayerIntelResult,
} from './contract';
import { buildPayerIntelRealDeps, sanitizePayerIntelSearchInput } from './deps';
import {
  loadPayerIntelEmployerOptions,
  loadPayerIntelFacilityOptions,
  loadPayerIntelPayerVocabulary,
} from './loaders';

/** The ambient board. `windowDays` drives BOTH rails (a 30d toggle shows 30d movers/decliners). */
export async function getPayerIntelBoard(
  windowDays?: unknown,
): Promise<{ ok: true; board: PayerIntelBoard } | { ok: false }> {
  try {
    return {
      ok: true,
      board: await getPayerIntelBoardCore(buildPayerIntelRealDeps(), {
        windowDays: clampPayerIntelWindowDays(windowDays),
      }),
    };
  } catch (err) {
    console.error('getPayerIntelBoard failed', err instanceof Error ? err.message : '');
    return { ok: false };
  }
}

/** One keyset page of the charge-line grid for the ACTIVE search (fixed Payment-Received-DESC).
 *  Dollar columns arrive already stripped for amounts-blind sessions. */
export async function loadPayerIntelChargeRows(
  input: unknown,
  cursor: unknown,
): Promise<{ ok: true; page: PayerIntelGridPage } | { ok: false }> {
  try {
    const c =
      typeof cursor === 'object' && cursor !== null && Number.isSafeInteger((cursor as { id?: unknown }).id)
        ? ({ id: (cursor as { id: number }).id, value: (cursor as { value?: string | number | null }).value ?? null } as PayerIntelGridCursor)
        : null;
    return {
      ok: true,
      page: await getPayerIntelGridCore(buildPayerIntelRealDeps(), sanitizePayerIntelSearchInput(input), c),
    };
  } catch (err) {
    console.error('loadPayerIntelChargeRows failed', err instanceof Error ? err.message : '');
    return { ok: false };
  }
}

export async function runPayerIntelSearch(
  input: unknown,
): Promise<{ ok: true; result: PayerIntelResult } | { ok: false }> {
  try {
    return {
      ok: true,
      result: await runPayerIntelSearchCore(buildPayerIntelRealDeps(), sanitizePayerIntelSearchInput(input)),
    };
  } catch (err) {
    console.error('runPayerIntelSearch failed', err instanceof Error ? err.message : '');
    return { ok: false };
  }
}

export async function togglePayerIntelStar(id: unknown, starred: unknown): Promise<PayerIntelToggleStarResult> {
  if (typeof id !== 'string' || typeof starred !== 'boolean') return { ok: false, reason: 'invalid' };
  return togglePayerIntelStarCore(buildPayerIntelRealDeps(), id, starred);
}

export async function clearPayerIntelHistory(): Promise<{ ok: boolean; persisted: boolean }> {
  try {
    return await clearPayerIntelHistoryCore(buildPayerIntelRealDeps());
  } catch (err) {
    console.error('clearPayerIntelHistory failed', err instanceof Error ? err.message : '');
    return { ok: false, persisted: false };
  }
}

export async function watchPayerIntelSubject(payer: unknown, prefix: unknown): Promise<PayerIntelWatchResult> {
  if (typeof payer !== 'string') return { ok: false, reason: 'invalid' };
  const cleanPrefix = typeof prefix === 'string' && prefix.trim().length > 0 ? prefix.trim() : null;
  return watchPayerIntelSubjectCore(buildPayerIntelRealDeps(), payer, cleanPrefix);
}

/** Employer type-ahead (≥3 chars; trigram-served; gate-first so the vocabulary never leaks). */
export async function searchPayerIntelEmployers(
  term: unknown,
): Promise<{ ok: true; employers: string[] } | { ok: false }> {
  const gate = await requirePayerIntelPrincipal();
  if (!gate.ok) return { ok: false };
  if (typeof term !== 'string' || term.trim().length < 3) return { ok: true, employers: [] };
  try {
    return { ok: true, employers: await loadPayerIntelEmployerOptions(term.trim().slice(0, 120), gate.entityIds) };
  } catch (err) {
    console.error('searchPayerIntelEmployers failed', err instanceof Error ? err.message : '');
    return { ok: false };
  }
}

/** Facility picker options + payer vocabulary for the facet chips (both small; gate-first).
 *  ⚠ Facility option VALUES are the rollup's facility TEXT — the vocabulary the filter matches. */
export async function loadPayerIntelFacetOptions(): Promise<
  | {
      ok: true;
      facilities: { value: string; name: string; careSetting: 'IP' | 'OP' | 'BOTH' | null }[];
      payers: string[];
    }
  | { ok: false }
> {
  const gate = await requirePayerIntelPrincipal();
  if (!gate.ok) return { ok: false };
  try {
    const [options, payers] = await Promise.all([
      loadPayerIntelFacilityOptions(gate.entityIds),
      loadPayerIntelPayerVocabulary(gate.entityIds),
    ]);
    return {
      ok: true,
      facilities: options
        .map((o) => ({ value: o.facility, name: o.facility_name ?? o.facility, careSetting: o.care_setting }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      payers,
    };
  } catch (err) {
    console.error('loadPayerIntelFacetOptions failed', err instanceof Error ? err.message : '');
    return { ok: false };
  }
}

/** Re-run a saved search from its stored non-PHI facets. Employer/group searches re-run DEGRADED
 *  (those facets are deliberately not persisted — 0104 header) and the card's entityType lets the
 *  UI say so. */
export async function rerunPayerIntelSavedSearch(saved: {
  payer: string | null;
  prefixEcho: string | null;
  entityType: PayerIntelEntityType | null;
}): Promise<{ ok: true; result: PayerIntelResult } | { ok: false }> {
  return runPayerIntelSearch({
    payer: typeof saved?.payer === 'string' ? saved.payer : null,
    prefix: typeof saved?.prefixEcho === 'string' ? saved.prefixEcho : null,
  });
}
