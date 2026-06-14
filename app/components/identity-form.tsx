'use client';

/**
 * client_history identity re-supply (gate 3). The agent NEVER echoes the patient
 * terms back, and they are not stored in query_log, so the rows for a
 * client_history result are only fetchable if the user re-enters the identity.
 *
 * These terms are PHI: they live ONLY in this form's local component state, are
 * passed transiently to the Server Action argument (a POST body under the hood),
 * and are never lifted into parent state, written to a URL/localStorage/cookie,
 * or logged. The parent receives the identity only as a call argument, not as
 * stored state.
 */
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { ResultsIdentity } from '@/lib/actions';

export function IdentityForm({
  pending,
  onSubmit,
}: {
  pending: boolean;
  onSubmit: (identity: ResultsIdentity) => void;
}) {
  const [patientLast, setPatientLast] = useState('');
  const [memberId, setMemberId] = useState('');

  const canSubmit = patientLast.trim() !== '' && !pending;

  return (
    <form
      className="space-y-3 rounded-md border border-dashed p-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!canSubmit) return;
        const identity: ResultsIdentity = { patient_last: patientLast.trim() };
        const member = memberId.trim();
        if (member !== '') identity.member_id_norm = member;
        onSubmit(identity);
      }}
    >
      <div>
        <p className="text-sm font-medium">Verify patient identity to view rows</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Re-enter the patient&apos;s last name (and member ID if you have it). These terms are
          verified server-side and are not stored.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="patient_last">Patient last name</Label>
          <Input
            id="patient_last"
            autoComplete="off"
            value={patientLast}
            onChange={(e) => setPatientLast(e.target.value)}
            placeholder="e.g. SMITH"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="member_id_norm">Member ID (optional)</Label>
          <Input
            id="member_id_norm"
            autoComplete="off"
            value={memberId}
            onChange={(e) => setMemberId(e.target.value)}
            placeholder="optional — narrows the match"
          />
        </div>
      </div>
      <Button type="submit" size="sm" disabled={!canSubmit}>
        {pending ? 'Verifying…' : 'Verify & show rows'}
      </Button>
    </form>
  );
}
