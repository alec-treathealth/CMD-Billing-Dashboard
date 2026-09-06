'use client';

/**
 * Ruling form CLIENT ISLAND — state and submission only; every pixel it renders comes from the pure
 * `RulingFormFields` leaf so the hermetic render suite can assert the markup without jsdom.
 *
 * ⚠️ NO DATABASE ACCESS HERE, AND NONE POSSIBLE. This is a Client Component; its only path to the
 * database is `rulePayerAlias`, a Server Action that re-gates on super_admin, re-validates with
 * zod .strict(), re-runs containment and calls the definer. The gate on the page is the front door,
 * never the lock — a hand-crafted POST reaches the same server-side checks.
 *
 * `router.refresh()` after a successful ruling re-renders the force-dynamic server page, so the row
 * leaves the queue and the tab counts fall. There is no client cache to drift.
 *
 * ONE ALIAS AT A TIME. There is no multi-select, no "confirm all", and no batching. The database
 * does not enforce that — see the H1 note in ruling-actions.ts.
 */
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { rulePayerAlias, type RulingFormInput } from '@/lib/payer-alias/ruling-actions';
import { RulingFormFields, type RulingFormState } from './payer-alias-leaves';
import type {
  PayerAliasRelationship,
  PayerAliasVocabulary,
} from '../../../src/collections/payerAliasQueue';

export interface RulingIdentityOption {
  canonical_payer_id: string;
  display_name: string;
  entity_kind: string | null;
}

export function PayerAliasRulingForm({
  vocabulary,
  alias,
  proposedCanonicalId,
  identities,
}: {
  vocabulary: PayerAliasVocabulary;
  alias: string;
  /** Pre-selects the machine's proposal so accepting it is one click, not a search. */
  proposedCanonicalId: string | null;
  identities: readonly RulingIdentityOption[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [errorField, setErrorField] = useState<string | null>(null);
  const [state, setState] = useState<RulingFormState>({
    action: 'confirm',
    relationship: 'same_payer' as PayerAliasRelationship,
    canonicalPayerId: proposedCanonicalId ?? '',
    reviewNote: '',
  });

  const onChange = (patch: Partial<RulingFormState>) => {
    setState((prev) => ({ ...prev, ...patch }));
    setError(null);
    setErrorField(null);
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        setErrorField(null);
        startTransition(async () => {
          // The payload is built explicitly rather than from FormData: .strict() rejects unknown
          // keys, and a stray input added to the markup later must not silently ride along.
          const payload: RulingFormInput = {
            vocabulary,
            aliasNorm: alias,
            action: state.action,
            // The server ignores these on a defer; sending null keeps the wire shape honest.
            relationship: state.action === 'confirm' ? state.relationship : null,
            canonicalPayerId:
              state.action === 'confirm' && state.canonicalPayerId !== ''
                ? state.canonicalPayerId
                : null,
            reviewNote: state.reviewNote === '' ? null : state.reviewNote,
          };
          const result = await rulePayerAlias(payload);
          if (result.ok) {
            // The row is now ruled and drops out of the queue on refresh.
            router.refresh();
            return;
          }
          setError(result.error);
          setErrorField(result.field ?? null);
        });
      }}
    >
      <RulingFormFields
        alias={alias}
        state={state}
        identities={identities}
        pending={pending}
        error={error}
        errorField={errorField}
        onChange={onChange}
        idPrefix={`ruling-${vocabulary}-${hashAlias(alias)}`}
      />
    </form>
  );
}

/**
 * A short stable id fragment for `<label for>` namespacing.
 *
 * ⚠️ NOT alias_norm ITSELF. The alias can be an employer name; putting it in a DOM id would place it
 * in a fragment-addressable identifier and in any `aria-describedby` a tool serialises. A numeric
 * hash is enough to keep N cards' labels distinct on one page.
 */
function hashAlias(alias: string): string {
  let h = 2166136261;
  for (let i = 0; i < alias.length; i += 1) {
    h ^= alias.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}
