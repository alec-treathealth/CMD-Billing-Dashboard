'use client';

/**
 * The Payer Intel search bar — the single coral/primary action on the page — plus the facet
 * browse chips beneath it (Payer · Employer · Funding · Group # · Facility).
 *
 * PHI DISCIPLINE: every term lives in component state and travels ONLY through the Server Action
 * POST body the parent submits. Nothing here writes a URL, localStorage, or a cookie. The group
 * number is an identifier — the parent never echoes it back (results carry a masked last-4).
 */
import { useId, useRef, useState } from 'react';
import { CMD_FUNDING_MARKETS } from '../../../src/collections/cmdExplorerQuery';

export interface PayerIntelSearchBarSubmit {
  term: string | null;
  payer: string | null;
  facilityCodes: string[];
  employerNames: string[];
  funding: string[];
  groupNumber: string | null;
}

type FacetPanel = 'payer' | 'employer' | 'funding' | 'group' | 'facility' | null;

export function PayerIntelSearchBar({
  payers,
  facilities,
  compressed,
  busy,
  onSubmit,
  onEmployerSearch,
}: {
  payers: readonly string[];
  facilities: readonly { code: string; name: string; careSetting: 'IP' | 'OP' | 'BOTH' | null }[];
  /** RESULT mode: slim bar, facet chips hidden (they live on the hero as ON FILE chips). */
  compressed: boolean;
  busy: boolean;
  onSubmit: (input: PayerIntelSearchBarSubmit) => void;
  onEmployerSearch: (term: string) => Promise<string[]>;
}) {
  const inputId = useId();
  const [term, setTerm] = useState('');
  const [panel, setPanel] = useState<FacetPanel>(null);
  const [payer, setPayer] = useState<string | null>(null);
  const [payerFilter, setPayerFilter] = useState('');
  const [employerTerm, setEmployerTerm] = useState('');
  const [employerOptions, setEmployerOptions] = useState<string[]>([]);
  const [employers, setEmployers] = useState<string[]>([]);
  const [funding, setFunding] = useState<string[]>([]);
  const [group, setGroup] = useState('');
  const [facilityCodes, setFacilityCodes] = useState<string[]>([]);
  const employerSeq = useRef(0);

  const submit = () => {
    onSubmit({
      term: term.trim().length > 0 ? term.trim() : null,
      payer,
      facilityCodes,
      employerNames: employers,
      funding,
      groupNumber: group.trim().length > 0 ? group.trim() : null,
    });
  };

  const facetCount = (payer ? 1 : 0) + employers.length + funding.length + (group.trim() ? 1 : 0) + facilityCodes.length;

  const chip = (key: Exclude<FacetPanel, null>, label: string, active: boolean) => (
    <button
      key={key}
      type="button"
      aria-expanded={panel === key}
      onClick={() => setPanel(panel === key ? null : key)}
      className={[
        'rounded-full border px-3 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal500',
        active
          ? 'border-teal200 bg-teal50 font-semibold text-teal700'
          : 'border-dashed border-line text-ink600 hover:border-teal200 hover:bg-teal50',
      ].join(' ')}
    >
      {label}
    </button>
  );

  return (
    <div
      data-pi-section="search"
      className={[
        'rounded-2xl border border-line bg-surface shadow-ths transition-[padding]',
        compressed ? 'p-4' : 'border-t-2 border-t-teal700 p-5',
      ].join(' ')}
    >
      <form
        className="flex gap-2.5"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="relative flex-1">
          <svg
            aria-hidden
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink400"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3.5-3.5" />
          </svg>
          <label htmlFor={inputId} className="sr-only">
            Search a prefix, payer, or group number
          </label>
          <input
            id={inputId}
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder="Prefix (W29) · payer (Aetna) · group #"
            autoComplete="off"
            className="w-full rounded-md border border-line bg-ground py-3 pl-10 pr-3.5 text-[15px] text-ink900 placeholder:text-ink400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal500"
          />
        </div>
        <button
          type="submit"
          disabled={busy}
          className="rounded-md bg-coral600 px-6 text-sm font-semibold text-white shadow-ths-sm transition-opacity hover:opacity-90 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal900"
        >
          {busy ? 'Searching…' : 'Find coverage'}
        </button>
      </form>

      {!compressed ? (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <span className="mr-0.5 text-[10px] font-semibold uppercase tracking-wider text-ink400">
              Browse facets{facetCount > 0 ? ` · ${facetCount} active` : ''}
            </span>
            {chip('payer', payer ?? 'Payer', payer !== null)}
            {chip('employer', employers.length > 0 ? `Employer (${employers.length})` : 'Employer', employers.length > 0)}
            {chip('funding', funding.length > 0 ? funding.join(' + ') : 'Funding', funding.length > 0)}
            {chip('group', group.trim() ? 'Group # set' : 'Group #', group.trim().length > 0)}
            {chip('facility', facilityCodes.length > 0 ? `Facility (${facilityCodes.length})` : 'Facility', facilityCodes.length > 0)}
          </div>

          {panel === 'payer' ? (
            <div className="mt-3 rounded-md border border-line bg-ground p-3">
              <input
                value={payerFilter}
                onChange={(e) => setPayerFilter(e.target.value)}
                placeholder="Filter payers…"
                aria-label="Filter payers"
                className="mb-2 w-full rounded border border-line bg-surface px-2.5 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal500"
              />
              <div className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
                {payers
                  .filter((p) => p.toLowerCase().includes(payerFilter.toLowerCase()))
                  .slice(0, 40)
                  .map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => {
                        setPayer(payer === p ? null : p);
                        setPanel(null);
                      }}
                      className={[
                        'rounded-full border px-2.5 py-1 text-xs',
                        payer === p ? 'border-teal700 bg-teal700 text-white' : 'border-line bg-surface text-ink600 hover:bg-teal50',
                      ].join(' ')}
                    >
                      {p}
                    </button>
                  ))}
              </div>
            </div>
          ) : null}

          {panel === 'employer' ? (
            <div className="mt-3 rounded-md border border-line bg-ground p-3">
              <input
                value={employerTerm}
                onChange={(e) => {
                  const v = e.target.value;
                  setEmployerTerm(v);
                  const seq = ++employerSeq.current;
                  if (v.trim().length >= 3) {
                    void onEmployerSearch(v.trim()).then((opts) => {
                      if (employerSeq.current === seq) setEmployerOptions(opts);
                    });
                  } else {
                    setEmployerOptions([]);
                  }
                }}
                placeholder="Type ≥3 characters to search employers…"
                aria-label="Search employers"
                className="mb-2 w-full rounded border border-line bg-surface px-2.5 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal500"
              />
              <div className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
                {employers.map((e) => (
                  <button
                    key={`sel-${e}`}
                    type="button"
                    onClick={() => setEmployers(employers.filter((x) => x !== e))}
                    className="rounded-full border border-teal700 bg-teal700 px-2.5 py-1 text-xs text-white"
                  >
                    {e} ×
                  </button>
                ))}
                {employerOptions
                  .filter((o) => !employers.includes(o))
                  .map((o) => (
                    <button
                      key={o}
                      type="button"
                      onClick={() => setEmployers([...employers, o])}
                      className="rounded-full border border-line bg-surface px-2.5 py-1 text-xs text-ink600 hover:bg-teal50"
                    >
                      {o}
                    </button>
                  ))}
              </div>
            </div>
          ) : null}

          {panel === 'funding' ? (
            <div className="mt-3 flex gap-2 rounded-md border border-line bg-ground p-3">
              {CMD_FUNDING_MARKETS.map((f) => (
                <button
                  key={f}
                  type="button"
                  aria-pressed={funding.includes(f)}
                  onClick={() => setFunding(funding.includes(f) ? funding.filter((x) => x !== f) : [...funding, f])}
                  className={[
                    'rounded-full border px-3 py-1 text-xs',
                    funding.includes(f) ? 'border-teal700 bg-teal700 text-white' : 'border-line bg-surface text-ink600 hover:bg-teal50',
                  ].join(' ')}
                >
                  {f}
                </button>
              ))}
              <span className="self-center text-[11px] text-ink400">VOB-verified members only — no-VOB charges drop out.</span>
            </div>
          ) : null}

          {panel === 'group' ? (
            <div className="mt-3 rounded-md border border-line bg-ground p-3">
              <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-ink600">
                Group number
              </label>
              <input
                value={group}
                onChange={(e) => setGroup(e.target.value)}
                inputMode="numeric"
                autoComplete="off"
                placeholder="e.g. 0084217"
                aria-label="Group number"
                className="w-56 rounded border border-line bg-surface px-2.5 py-1.5 font-mono text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal500"
              />
              <p className="mt-1.5 text-[11px] text-ink400">
                Sent securely with the search — never shown in the URL and stored only as a masked echo.
              </p>
            </div>
          ) : null}

          {panel === 'facility' ? (
            <div className="mt-3 rounded-md border border-line bg-ground p-3">
              <div className="flex max-h-44 flex-wrap gap-1.5 overflow-y-auto">
                {facilities.map((f) => {
                  const on = facilityCodes.includes(f.code);
                  return (
                    <button
                      key={f.code}
                      type="button"
                      aria-pressed={on}
                      onClick={() =>
                        setFacilityCodes(on ? facilityCodes.filter((c) => c !== f.code) : [...facilityCodes, f.code])
                      }
                      className={[
                        'rounded-full border px-2.5 py-1 text-xs',
                        on ? 'border-teal700 bg-teal700 text-white' : 'border-line bg-surface text-ink600 hover:bg-teal50',
                      ].join(' ')}
                    >
                      {f.name}
                      {f.careSetting ? ` · ${f.careSetting === 'BOTH' ? 'IP+OP' : f.careSetting}` : ''}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
