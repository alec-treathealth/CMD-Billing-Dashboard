/**
 * A one-slot, IN-MEMORY handoff from the header bell to the AR workbench: "open this claim when
 * you mount". It exists so a notification click can land on /billing-audit with the drawer open
 * WITHOUT putting the claim id in the URL (an account-number-class identifier never travels in a
 * query string — CLAUDE.md standing rules) and WITHOUT browser storage (nothing app-state in
 * localStorage / cookies). Module state survives a client-side navigation because it is the same
 * bundle; a hard reload clears it, which is the correct failure mode (nothing stale, nothing leaked).
 */
export interface PendingClaim {
  view: 'bxr' | 'indigo';
  cmdClaimId: string;
}

let pending: PendingClaim | null = null;

export function setPendingClaim(p: PendingClaim): void {
  pending = p;
}

/** Read AND clear — a pending open is consumed exactly once. */
export function takePendingClaim(): PendingClaim | null {
  const p = pending;
  pending = null;
  return p;
}
