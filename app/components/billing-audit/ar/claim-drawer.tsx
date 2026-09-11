'use client';

/**
 * The CLAIM WORKSPACE — a focus-trapped right slide-over (useDialog) that reads like a case file:
 * identity (masked → gated reveal), the money strip, STATUS & REASONING (CMD status, where the claim
 * sits, the last 835, the last clearinghouse/payer error, and the CAS denial table with plain-English
 * descriptions), the charge lines, the NOTES thread (CMD-imported + in-app, newest first), and the
 * WORK panel (status / assignee / due date / resolution). Every write refreshes the drawer AND the
 * queue row behind it (onChanged) — dimmed while in flight, never re-skeletoned.
 *
 * PHI: nothing PHI is fetched until the user acts. Notes are fetched only for canRevealPhi roles
 * (they carry incidental PHI) and the identifier reveal is the separate audited action.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useDialog } from '../../qualify/useDialog';
import { addArNoteAction, loadArClaimDetailAction, loadArNotesAction, revealArPatientAction, setArWorkAction } from '@/lib/ar/actions';
import { WORK_STATUS_META, type ArAssigneeOption, type ArClaimDetail, type ArNote, type ArRevealedPatient, type ArWorkStatus } from '@/lib/ar/contract';
import type { DashboardView } from '@/lib/views';
import { describeGroupCode, describeRemitCode } from '../../../../src/billingAudit/carcDescriptions';
import { ArStatusChip, BandPill, WorkChip, clp02Label, dateRange, money, relativeTime, shortDate } from './ar-leaves';

export interface DrawerTarget { cmdClaimId: string; cmdPatientId: string | null }

export interface ClaimDrawerProps {
  view: DashboardView;
  canRevealPhi: boolean;
  canWork: boolean;
  target: DrawerTarget | null;
  assignees: ArAssigneeOption[];
  onClose: () => void;
  onChanged: () => void;
}

function Section({ title, children, aside }: { title: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section className="border-t border-line px-5 py-4">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-ink400">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Fact({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-ink400">{label}</div>
      <div className={`truncate text-sm text-ink900 ${mono ? 'ths-num' : ''}`}>{value ?? '—'}</div>
    </div>
  );
}

const INPUT = 'h-9 w-full rounded-md border border-line bg-surface px-2 text-sm text-ink900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

export function ClaimDrawer({ view, canRevealPhi, canWork, target, assignees, onClose, onChanged }: ClaimDrawerProps) {
  const open = target !== null;
  const dialogRef = useDialog<HTMLElement>(onClose, { trap: true, active: open });
  const [detail, setDetail] = useState<ArClaimDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [notes, setNotes] = useState<ArNote[] | null>(null);
  const [notesLoading, setNotesLoading] = useState(false);
  // Keyed by the patient it belongs to. A bare ArRevealedPatient could be painted onto whatever
  // claim happens to be open when a slow reveal lands — see the targetRef note below.
  const [revealed, setRevealed] = useState<{ patientId: string; patient: ArRevealedPatient } | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState('');
  const [savingNote, setSavingNote] = useState(false);
  const [work, setWork] = useState<{ status: ArWorkStatus; assignee: string; due: string; resolution: string }>({ status: 'open', assignee: '', due: '', resolution: '' });
  const [savingWork, setSavingWork] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState<number | null>(null);
  useEffect(() => { setNowMs(Date.now()); }, [detail]);
  // Load token: a late response for a claim that is no longer selected (or a closed drawer) must not
  // populate the drawer — and must never seed the work form a save could then write to the wrong claim.
  const loadToken = useRef(0);
  /**
   * THE CLAIM THIS DRAWER IS CURRENTLY POINTED AT, readable from inside an async callback.
   *
   * `loadToken` already protected `loadAll`, but the three MUTATING paths (reveal, submitNote,
   * submitWork) each did `setState` after an un-abortable Server Action without checking that the
   * drawer still pointed where it did when the call started. Server Actions cannot be cancelled, so
   * "the user closed this and opened another claim" is a normal event, not an edge case. Two real
   * corruptions came out of that:
   *
   *   - WRONG-CLAIM WRITE. Save on claim A, close, open claim B; A's response lands and
   *     `await loadAll(A)` takes a NEWER token, discarding B's in-flight load. The drawer is
   *     targeted at B but shows A, and `work` holds A's values — so the next Save writes A's
   *     status / assignee / due date / resolution onto B, logs an ar_claim_event against B, and
   *     notifies every super-admin that B moved. B's real disposition is gone silently.
   *   - WRONG-PATIENT IDENTITY. `reveal` called setRevealed unconditionally, so a late reveal for
   *     patient Alice rendered "Alice · DOB · Member" as the header of claim B. An operator then
   *     quotes Alice's DOB to a payer about someone else's claim. That is a PHI misattribution,
   *     which is worse than a failed reveal.
   *
   * A ref, not state: the async callback must read the value at RESUME time, and a captured
   * closure variable is exactly the stale thing we are defending against.
   */
  const targetRef = useRef<string | null>(null);

  const claimId = target?.cmdClaimId ?? null;

  const loadAll = useCallback(async (id: string) => {
    const token = ++loadToken.current;
    setLoading(true);
    setErr(null);
    const res = await loadArClaimDetailAction(view, id);
    if (token !== loadToken.current) return;
    if (!res.ok) { setErr(res.error); setLoading(false); return; }
    setDetail(res.detail);
    setWork({
      status: res.detail.claim.work_status,
      assignee: res.detail.claim.assignee_user_id ?? '',
      due: res.detail.claim.due_on ?? '',
      resolution: res.detail.claim.resolution_code ?? '',
    });
    setLoading(false);
    if (canRevealPhi) {
      setNotesLoading(true);
      const n = await loadArNotesAction(view, id);
      if (token !== loadToken.current) return;
      setNotes(n.ok ? n.notes : []);
      if (!n.ok) setErr(n.error);
      setNotesLoading(false);
    }
  }, [view, canRevealPhi]);

  useEffect(() => {
    loadToken.current += 1; // abandon any in-flight load for the previous claim
    targetRef.current = claimId;
    setDetail(null); setNotes(null); setRevealed(null); setErr(null); setNoteDraft(''); setSaved(null);
    // `work` MUST be reset here too. It used to survive a claim change until loadAll replaced it, so
    // between switching claims and that load resolving (or if it failed) the form held the previous
    // claim's disposition and a Save wrote it to the new one.
    setWork({ status: 'open', assignee: '', due: '', resolution: '' });
    if (claimId) void loadAll(claimId);
  }, [claimId, loadAll]);

  const reveal = async () => {
    if (!detail) return;
    const id = targetRef.current;
    const patientId = detail.claim.cmd_patient_id;
    setRevealing(true); setErr(null);
    const res = await revealArPatientAction(view, patientId);
    // The drawer moved while the decrypt was in flight — drop the identity on the floor. The audit
    // row is already written server-side, which is correct: the reveal DID happen.
    if (targetRef.current !== id) return;
    if (res.ok) setRevealed({ patientId, patient: res.patient }); else setErr(res.error);
    setRevealing(false);
  };

  const submitNote = async () => {
    if (!claimId || noteDraft.trim().length === 0) return;
    setSavingNote(true); setErr(null);
    const id = claimId;
    const res = await addArNoteAction(view, id, noteDraft.trim());
    // Navigated away: the write landed, so refresh the LIST, but do not re-seed this drawer from a
    // claim it is no longer showing (that is what repointed the form at the wrong claim).
    if (targetRef.current !== id) { onChanged(); return; }
    setSavingNote(false);
    if (!res.ok) { setErr(res.error); return; }
    setNoteDraft('');
    setSaved('Note added');
    await loadAll(id);
    onChanged();
  };

  const submitWork = async () => {
    if (!claimId) return;
    setSavingWork(true); setErr(null);
    const a = assignees.find((x) => x.user_id === work.assignee) ?? null;
    const res = await setArWorkAction(view, claimId, {
      workStatus: work.status,
      assigneeUserId: a?.user_id ?? null,
      assigneeEmail: a?.email ?? null,
      dueOn: work.due || null,
      resolutionCode: work.resolution.trim() || null,
    });
    if (targetRef.current !== claimId) { onChanged(); return; }
    setSavingWork(false);
    if (!res.ok) { setErr(res.error); return; }
    setSaved('Work status saved');
    await loadAll(claimId);
    onChanged();
  };

  const denials = useMemo(() => (detail?.remits ?? []).filter((r) => r.kind === 'A' && (r.is_denial || r.group_code === 'CO' || r.group_code === 'PI' || r.group_code === 'OA')), [detail]);
  const remarks = useMemo(() => (detail?.remits ?? []).filter((r) => r.kind === 'R'), [detail]);

  if (!open) return null;
  const c = detail?.claim ?? null;
  // The FINAL guard on patient identity: render a decrypted name only when it belongs to the patient
  // whose claim is on screen. Even if a stale identity somehow reached state, it cannot be painted
  // onto another patient's claim — a mismatch falls back to the mask, never to the wrong name.
  const shown = revealed !== null && c !== null && revealed.patientId === c.cmd_patient_id ? revealed.patient : null;

  return (
    <>
      <div aria-hidden className="fixed inset-0 z-40 bg-[rgba(20,30,29,0.28)] transition-opacity duration-150" onClick={onClose} />
      <aside
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="ar-drawer-title"
        className="animate-ths-reveal fixed inset-y-0 right-0 z-50 flex w-[min(40rem,100vw)] flex-col border-l border-line bg-surface shadow-ths-lg focus:outline-none"
      >
        <header className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0">
            <div className="text-xs font-semibold uppercase tracking-wide text-ink400">
              {c ? `${c.facility_code}${c.facility_name ? ` · ${c.facility_name}` : ''}` : 'Claim'}
            </div>
            <h2 id="ar-drawer-title" className="ths-h mt-0.5 flex items-baseline gap-2 text-lg font-semibold text-ink900">
              <span className={shown ? '' : 'tracking-widest text-ink400'}>{shown ? shown.patient_name : '••••••'}</span>
              {c ? <span className="ths-num text-xs font-medium text-ink400">claim #{c.cmd_claim_id}</span> : null}
            </h2>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-ink600">
              {shown ? (
                <>
                  <span className="ths-num">DOB {shortDate(shown.patient_dob)}</span>
                  <span className="ths-num">Member {shown.member_id ?? '—'}</span>
                </>
              ) : c ? <span className="ths-num">patient #{c.cmd_patient_id}</span> : null}
              {canRevealPhi && !shown ? (
                <button type="button" onClick={reveal} disabled={revealing || !c} className="rounded-md border border-teal200 bg-teal50 px-2 py-0.5 text-xs font-semibold text-teal700 transition-colors hover:bg-teal200 disabled:opacity-60">
                  {revealing ? 'Revealing…' : 'Reveal identifiers'}
                </button>
              ) : null}
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close claim" className="rounded-md p-1.5 text-ink400 transition-colors hover:bg-ground hover:text-ink900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <X aria-hidden className="h-5 w-5" />
          </button>
        </header>

        <div className={`min-h-0 flex-1 overflow-y-auto transition-opacity duration-150 ${loading ? 'opacity-60' : ''}`}>
          {err ? <div role="alert" className="mx-5 mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</div> : null}
          {saved ? <div role="status" className="mx-5 mt-3 rounded-md border border-teal200 bg-teal50 px-3 py-2 text-sm text-teal700">{saved}</div> : null}

          {!c ? (
            <p className="px-5 py-10 text-center text-sm text-ink400">{loading ? 'Loading claim…' : 'Claim unavailable.'}</p>
          ) : (
            <>
              {/* Money strip */}
              <div className="grid grid-cols-5 gap-px bg-line">
                {[
                  ['Charged', c.total_charges], ['Ins. paid', c.ins_paid], ['Pt. paid', c.pat_paid], ['Adjustments', c.adjustments], ['Balance', c.balance],
                ].map(([label, v], i) => (
                  <div key={label} className={`bg-surface px-3 py-3 ${i === 4 ? 'bg-teal50' : ''}`}>
                    <div className="text-xs text-ink400">{label}</div>
                    <div className={`font-display mt-0.5 text-base font-medium leading-none ${i === 4 ? 'text-[var(--brand-ink)]' : 'text-ink900'}`}>{money(v)}</div>
                  </div>
                ))}
              </div>

              <div className="grid grid-cols-2 gap-x-4 gap-y-3 px-5 py-4 sm:grid-cols-3">
                <Fact label="Dates of service" value={dateRange(c.dos_from, c.dos_to)} mono />
                <Fact label="Age" value={<BandPill band={c.band} ageDays={c.age_days} />} />
                {/* Shows the EFFECTIVE state, outlined while it is still CMD's inference. The
                    editor below is seeded from c.work_status (the human column) — NOT from this —
                    so opening a claim and pressing Save cannot silently promote CMD's guess into
                    somebody's recorded decision. ⚠ `has_human_work` is row existence, not
                    `work_status !== 'open'`: this editor's own Save writes an 'open' row whenever
                    a user changes only the assignee or the due date. */}
                <Fact label="Work" value={<WorkChip status={c.effective_work_state} derived={!c.has_human_work} />} />
                <Fact label="Codes" value={`${c.cpt_codes.join(' ') || '—'}${c.rev_codes.length ? ` / rev ${c.rev_codes.join(' ')}` : ''}`} mono />
                <Fact label="Type of bill" value={c.type_of_bill ?? '—'} mono />
                <Fact label="Claim type" value={c.claim_type === 'I' ? 'Institutional' : c.claim_type === 'P' ? 'Professional' : c.claim_type ?? '—'} />
              </div>

              <Section title="Status & reasoning">
                <div className="flex flex-wrap items-center gap-2">
                  <ArStatusChip statusRaw={c.status_raw} statusCategory={c.status_category} statusPayer={c.status_payer} cmdStatusText={c.cmd_status_text} />
                  <span className="text-xs text-ink600">{c.status_raw}</span>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
                  <Fact label="Primary payer" value={c.primary_payer_name ?? '—'} />
                  <Fact label="Claim is at" value={c.current_payer_name ?? '—'} />
                  <Fact label="Last 835" value={c.last_835_status ? `${clp02Label(c.last_835_status) ?? `CLP02 ${c.last_835_status}`}` : '—'} />
                  <Fact label="CMD follow-up" value={c.cmd_followup_date ? shortDate(c.cmd_followup_date) : '—'} mono />
                  <Fact label="Last billed" value={detail?.lines.map((l) => l.last_bill_date).filter(Boolean).sort().pop() ?? '—'} mono />
                  <Fact label="Ins. last paid" value={detail?.lines.map((l) => l.ins_last_payment_date).filter(Boolean).sort().pop() ?? '—'} mono />
                </div>
                {c.last_error_code ? (
                  <div className="mt-3 rounded-md border border-status-danger/30 bg-status-danger/5 px-3 py-2 text-sm">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="rounded bg-status-danger/10 px-1.5 py-0.5 font-semibold text-status-danger">Last error · {c.last_error_code}</span>
                      {detail?.statusEvents.find((e) => e.status_code === c.last_error_code)?.receiver_name ? <span className="text-ink600">{detail.statusEvents.find((e) => e.status_code === c.last_error_code)?.receiver_name}</span> : null}
                    </div>
                    <p className="mt-1 text-ink900">{detail?.statusEvents.find((e) => e.status_type !== 'INFO')?.status_message ?? '—'}</p>
                    {detail?.statusEvents.find((e) => e.status_type !== 'INFO')?.action_message ? <p className="mt-0.5 text-xs text-ink600">{detail.statusEvents.find((e) => e.status_type !== 'INFO')?.action_message}</p> : null}
                  </div>
                ) : null}
                {denials.length > 0 ? (
                  <div className="mt-3 overflow-hidden rounded-md border border-line">
                    <table className="w-full text-xs">
                      <thead className="bg-ground text-left text-ink400">
                        <tr><th className="px-2 py-1.5 font-medium">Group</th><th className="px-2 py-1.5 font-medium">Code</th><th className="px-2 py-1.5 font-medium">Meaning</th><th className="px-2 py-1.5 text-right font-medium">Amount</th><th className="px-2 py-1.5 font-medium">Received</th></tr>
                      </thead>
                      <tbody>
                        {denials.slice(0, 12).map((r) => (
                          <tr key={r.id} className="border-t border-line">
                            <td className="ths-num px-2 py-1.5 text-ink600" title={describeGroupCode(r.group_code) ?? undefined}>{r.group_code ?? '—'}</td>
                            <td className="ths-num px-2 py-1.5 font-semibold text-ink900">{r.code}</td>
                            <td className="px-2 py-1.5 text-ink900">{describeRemitCode(r.code) ?? <span className="text-ink400">—</span>}</td>
                            <td className="ths-num px-2 py-1.5 text-right text-ink900">{money(r.amount)}</td>
                            <td className="ths-num px-2 py-1.5 text-ink600">{shortDate(r.received_date)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {remarks.length > 0 ? (
                      <div className="border-t border-line bg-ground px-2 py-1.5 text-xs text-ink600">
                        Remarks: {[...new Set(remarks.map((r) => r.code))].slice(0, 8).map((code) => <span key={code} className="ths-num mr-2" title={describeRemitCode(code) ?? undefined}>{code}</span>)}
                      </div>
                    ) : null}
                  </div>
                ) : <p className="mt-3 text-xs text-ink400">No CO / PI / OA adjustments on file for this claim.</p>}
              </Section>

              <Section title={`Charge lines · ${detail?.lines.length ?? 0}`}>
                <div className="overflow-x-auto rounded-md border border-line">
                  <table className="w-full text-xs">
                    <thead className="bg-ground text-left text-ink400">
                      <tr><th className="px-2 py-1.5 font-medium">DOS</th><th className="px-2 py-1.5 font-medium">CPT / rev</th><th className="px-2 py-1.5 text-right font-medium">Charged</th><th className="px-2 py-1.5 text-right font-medium">Paid</th><th className="px-2 py-1.5 text-right font-medium">Balance</th><th className="px-2 py-1.5 font-medium">Status</th></tr>
                    </thead>
                    <tbody>
                      {(detail?.lines ?? []).map((l) => (
                        <tr key={l.id} className={`border-t border-line ${Number(l.balance) > 0 ? '' : 'text-ink400'}`}>
                          <td className="ths-num px-2 py-1.5">{dateRange(l.dos_from, l.dos_to)}</td>
                          <td className="ths-num px-2 py-1.5">{l.cpt_code ?? '—'}{l.modifiers ? ` ${l.modifiers}` : ''}{l.rev_code ? <span className="text-ink400"> / {l.rev_code}</span> : null}</td>
                          <td className="ths-num px-2 py-1.5 text-right">{money(l.charge_amount)}</td>
                          <td className="ths-num px-2 py-1.5 text-right">{money(Number(l.ins_paid) + Number(l.pat_paid))}</td>
                          <td className={`ths-num px-2 py-1.5 text-right ${Number(l.balance) > 0 ? 'font-semibold text-ink900' : ''}`}>{money(l.balance)}</td>
                          <td className="px-2 py-1.5"><span className="truncate">{l.status_raw}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Section>

              <Section title={`Notes · ${notes?.length ?? c.cmd_note_count}`} aside={!canRevealPhi ? <span className="text-xs text-ink400">Notes require a PHI role</span> : null}>
                {canWork ? (
                  <div className="mb-3">
                    <label className="sr-only" htmlFor="ar-note-draft">Add a note</label>
                    <textarea
                      id="ar-note-draft"
                      value={noteDraft}
                      onChange={(e) => setNoteDraft(e.target.value.slice(0, 4000))}
                      rows={3}
                      placeholder="Call log, reference #, next step… (encrypted at rest)"
                      className="w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink900 placeholder:text-ink400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    />
                    <div className="mt-1 flex items-center justify-between">
                      <span className="ths-num text-xs text-ink400">{noteDraft.length}/4000</span>
                      <button type="button" onClick={submitNote} disabled={savingNote || noteDraft.trim().length === 0} className="h-8 rounded-md bg-teal700 px-3 text-xs font-semibold text-white transition-colors hover:bg-teal900 disabled:opacity-50">
                        {savingNote ? 'Saving…' : 'Add note'}
                      </button>
                    </div>
                  </div>
                ) : null}
                {notesLoading ? <p className="text-xs text-ink400">Loading notes…</p> : null}
                {notes && notes.length === 0 ? <p className="text-xs text-ink400">No notes yet.</p> : null}
                <ol className="space-y-2">
                  {(notes ?? []).map((n) => (
                    <li key={n.id} className={`rounded-md border px-3 py-2 ${n.source === 'user' ? 'border-teal200 bg-teal50/40' : 'border-line bg-card'}`}>
                      <div className="flex flex-wrap items-center gap-x-2 text-xs text-ink400">
                        <span className="font-semibold text-ink900">{n.author}</span>
                        <span>{n.source === 'cmd' ? (n.claim_level ? 'CMD · this claim' : 'CMD · patient account') : 'AR Management'}</span>
                        <span className="ths-num ml-auto" title={n.noted_at}>{relativeTime(n.noted_at, nowMs) ?? shortDate(n.noted_at)}</span>
                      </div>
                      <p className="mt-1 whitespace-pre-wrap text-sm text-ink900">{n.text}</p>
                    </li>
                  ))}
                </ol>
              </Section>

              {canWork ? (
                <Section title="Work">
                  <div className="grid grid-cols-2 gap-3">
                    <label className="text-xs text-ink600">Status
                      <select className={`${INPUT} mt-1`} value={work.status} onChange={(e) => setWork({ ...work, status: e.target.value as ArWorkStatus })}>
                        {WORK_STATUS_META.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                      </select>
                    </label>
                    <label className="text-xs text-ink600">Assignee
                      <select className={`${INPUT} mt-1`} value={work.assignee} onChange={(e) => setWork({ ...work, assignee: e.target.value })}>
                        <option value="">Unassigned</option>
                        {assignees.map((a) => <option key={a.user_id} value={a.user_id}>{a.email}</option>)}
                      </select>
                    </label>
                    <label className="text-xs text-ink600">Due
                      <input type="date" className={`${INPUT} mt-1`} value={work.due} onChange={(e) => setWork({ ...work, due: e.target.value })} />
                    </label>
                    <label className="text-xs text-ink600">Resolution
                      <input type="text" maxLength={60} className={`${INPUT} mt-1`} placeholder="e.g. paid · appeal won · written off" value={work.resolution} onChange={(e) => setWork({ ...work, resolution: e.target.value })} />
                    </label>
                  </div>
                  <div className="mt-3 flex items-center justify-between">
                    <span className="text-xs text-ink400">Changes notify super-admins.</span>
                    <button type="button" onClick={submitWork} disabled={savingWork} className="h-9 rounded-md bg-[var(--brand-ink)] px-4 text-sm font-semibold text-white transition-colors hover:opacity-90 disabled:opacity-50">
                      {savingWork ? 'Saving…' : 'Save work status'}
                    </button>
                  </div>
                </Section>
              ) : null}

              {detail && detail.events.length > 0 ? (
                <Section title="Activity">
                  <ol className="space-y-1 text-xs">
                    {detail.events.map((e) => (
                      <li key={e.id} className="flex flex-wrap items-baseline gap-x-2 text-ink600">
                        <span className="ths-num text-ink400" title={e.created_at}>{relativeTime(e.created_at, nowMs) ?? shortDate(e.created_at)}</span>
                        <span className="font-medium text-ink900">{e.actor_email.split('@')[0]}</span>
                        <span>{e.event_type === 'note' ? 'added a note' : e.event_type === 'status' ? `moved ${e.from_value ?? 'open'} → ${e.to_value}` : e.event_type === 'assign' ? `assigned to ${e.to_value ?? 'nobody'}` : e.event_type === 'due' ? `set due ${e.to_value ?? '—'}` : `resolution: ${e.to_value ?? '—'}`}</span>
                      </li>
                    ))}
                  </ol>
                </Section>
              ) : null}

              {detail && detail.statusEvents.length > 0 ? (
                <Section title={`Clearinghouse & payer status · ${detail.statusEvents.length}`}>
                  <ol className="space-y-1 text-xs">
                    {detail.statusEvents.slice(0, 12).map((e) => (
                      <li key={e.id} className="flex flex-wrap items-baseline gap-x-2">
                        <span className="ths-num text-ink400">{shortDate(e.status_date)}</span>
                        <span className={`rounded px-1 font-semibold ${e.status_type === 'ERROR' ? 'bg-status-danger/10 text-status-danger' : e.status_type === 'WARNING' ? 'bg-status-warn/10 text-status-warn' : 'bg-ground text-ink600'}`}>{e.status_type}{e.status_code ? ` ${e.status_code}` : ''}</span>
                        <span className="text-ink600">{e.receiver_name}</span>
                        <span className="w-full text-ink900">{e.status_message}</span>
                      </li>
                    ))}
                  </ol>
                </Section>
              ) : null}
            </>
          )}
        </div>
      </aside>
    </>
  );
}
