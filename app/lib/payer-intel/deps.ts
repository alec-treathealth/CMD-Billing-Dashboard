/**
 * Payer Intel REAL DEPS assembly + trust-boundary input sanitizer — a plain server-only module,
 * deliberately NOT `'use server'`: those files may export only async functions, and this exports
 * sync factories both binders (actions.ts, ai-actions.ts) share. Importing it from a Client
 * Component fails the build loudly (it pulls the pg pool via loaders).
 */
import { requirePayerIntelPrincipal } from './gate';
import type { PayerIntelDeps } from './core';
import type { PayerIntelSearchInput } from './contract';
import {
  clearPayerIntelSearchesRow,
  loadPayerIntelCensus,
  loadPayerIntelCohortCurve,
  loadPayerIntelDecliners,
  loadPayerIntelFacilityNames,
  loadPayerIntelGainers,
  loadPayerIntelPayerGroups,
  loadPayerIntelPayerVocabulary,
  loadPayerIntelRating,
  loadPayerIntelSavedSearches,
  loadPayerIntelSearchAggregates,
  recordPayerIntelSearchRow,
  setPayerIntelSearchStarredRow,
} from './loaders';
import { loadQualifyPolicyTapeContext, saveQualifyWatcherRow } from '../qualify/loaders';
import { qualifyBusinessDayIso } from '../qualify/contract';
import { recordAccess } from '../server';
import { prefixLabelsFor } from '../../../src/collections/prefixLabel';
import { alphaPrefixBlindIndex, groupNumberBlindIndex } from '../../../src/collections/blindIndex';
import { COHORT_MIN_PATIENTS } from '../../../src/collections/cmdExplorerQuery';
import { QUALIFY_TAPE_DELTA_DAYS } from '../../../src/collections/qualifyRatingHistory';

/** The default trend-watcher threshold (pts) the hero's Watch button saves with — the Qualify
 *  watchboard's own default. */
export const PAYER_INTEL_WATCH_DEFAULT_THRESHOLD_PTS = 3;

export function buildPayerIntelRealDeps(): PayerIntelDeps {
  return {
    requirePrincipal: requirePayerIntelPrincipal,
    loadGainers: loadPayerIntelGainers,
    resolvePrefixes: prefixLabelsFor,
    loadTapeContext: loadQualifyPolicyTapeContext,
    loadDecliners: loadPayerIntelDecliners,
    loadCensus: loadPayerIntelCensus,
    loadFacilityNames: loadPayerIntelFacilityNames,
    loadSavedSearches: loadPayerIntelSavedSearches,
    loadAggregates: loadPayerIntelSearchAggregates,
    loadPayerGroups: loadPayerIntelPayerGroups,
    loadRating: loadPayerIntelRating,
    loadPayerVocabulary: loadPayerIntelPayerVocabulary,
    alphaPrefixToken: (raw) => alphaPrefixBlindIndex(raw),
    groupNumberToken: (raw) => groupNumberBlindIndex(raw),
    recordAccess,
    recordSearch: recordPayerIntelSearchRow,
    setStarred: setPayerIntelSearchStarredRow,
    clearSearches: clearPayerIntelSearchesRow,
    saveWatcher: (args) =>
      saveQualifyWatcherRow({
        userId: args.userId,
        kind: 'trend',
        payer: args.payer,
        token: args.token,
        echo: null,
        thresholdPts: PAYER_INTEL_WATCH_DEFAULT_THRESHOLD_PTS,
      }),
    loadCohortCurve: loadPayerIntelCohortCurve,
    cohortMinPatients: COHORT_MIN_PATIENTS,
    today: () => qualifyBusinessDayIso(new Date()),
    windowDays: QUALIFY_TAPE_DELTA_DAYS,
  };
}

/** Shape-check the client's search input at the trust boundary (the core sanitizes values again). */
export function sanitizePayerIntelSearchInput(input: unknown): PayerIntelSearchInput {
  if (typeof input !== 'object' || input === null) return {};
  const o = input as Record<string, unknown>;
  const str = (v: unknown, max: number): string | null =>
    typeof v === 'string' && v.trim().length > 0 ? v.trim().slice(0, max) : null;
  const strArr = (v: unknown, maxLen: number, maxItems: number): string[] =>
    Array.isArray(v)
      ? v.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= maxLen).slice(0, maxItems)
      : [];
  return {
    term: str(o.term, 120),
    payer: str(o.payer, 120),
    prefix: str(o.prefix, 3),
    facilityCodes: strArr(o.facilityCodes, 40, 20),
    employerNames: strArr(o.employerNames, 200, 50),
    funding: strArr(o.funding, 20, 2),
    groupNumber: str(o.groupNumber, 40),
  };
}
