'use client';

/**
 * Mobile VOB market filter — the employer type-ahead + funding pills for the Qualify PWA, styled with
 * the mobile inline-token language (NOT the desktop MultiSelectTagPicker, which is Tailwind-class based
 * and doesn't match this teal/ground surface). Self-contained: it owns the employer type-ahead fetch
 * (loadQualifyEmployers, debounced) + query/options/loading/display state internally, and lifts ONLY
 * the resolved selections up via onEmployersChange / onFundingChange so the parent's market memo can
 * read them. Funding is a static two-value market; employer is a server search (the ~11.6k vocabulary
 * is too large to load whole). All values feed a VOB semi-join server-side — no-VOB members drop out.
 */
import { useEffect, useRef, useState } from 'react';
import { loadQualifyEmployers } from '@/lib/qualify/actions';
import type { CmdEmployerOption } from '@/lib/actions';

const INK900 = '#1B2B2A';
const INK400 = '#859794';
const TEAL900 = '#0E3A3A';
const CHIP_BG = '#EEF2F0';
const BORDER = '#E2E8E5';

const FUNDING: readonly { value: string; label: string }[] = [
  { value: 'Self-Funded', label: 'Self-funded' },
  { value: 'Fully Insured', label: 'Fully insured' },
];

export function MobileMarketFilter({
  employers,
  funding,
  onEmployersChange,
  onFundingChange,
}: {
  employers: string[];
  funding: string[];
  onEmployersChange: (next: string[]) => void;
  onFundingChange: (next: string[]) => void;
}) {
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<CmdEmployerOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  // value→friendly name, accumulated as options arrive, so a selected employer's chip keeps its label
  // even after the query (and thus `options`) moves on.
  const displayRef = useRef<Map<string, string>>(new Map());

  // Debounced server type-ahead (mirrors the desktop tab). A sub-3-char term never hits the DB.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 3) {
      setOptions([]);
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    const t = setTimeout(() => {
      loadQualifyEmployers(q)
        .then((r) => {
          if (!alive) return;
          const opts = r.ok ? r.employers : [];
          for (const o of opts) displayRef.current.set(o.employer_norm, o.employer_name ?? o.employer_norm);
          setOptions(opts);
          setLoading(false);
        })
        .catch(() => {
          if (!alive) return;
          setOptions([]);
          setLoading(false);
        });
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [query]);

  const toggleFunding = (value: string) =>
    onFundingChange(funding.includes(value) ? funding.filter((v) => v !== value) : [...funding, value]);
  const toggleEmployer = (value: string) =>
    onEmployersChange(employers.includes(value) ? employers.filter((v) => v !== value) : [...employers, value]);

  const employerSet = new Set(employers);
  const q = query.trim();

  return (
    <div style={{ padding: '10px 16px 0' }}>
      {/* Funding pills */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: INK400, textTransform: 'uppercase', letterSpacing: 0.3 }}>
          Funding
        </span>
        {FUNDING.map((f) => {
          const active = funding.includes(f.value);
          return (
            <button
              key={f.value}
              type="button"
              aria-pressed={active}
              onClick={() => toggleFunding(f.value)}
              style={{
                padding: '4px 12px',
                borderRadius: 999,
                border: 'none',
                fontSize: 11,
                fontWeight: 700,
                cursor: 'pointer',
                background: active ? TEAL900 : CHIP_BG,
                color: active ? '#fff' : INK400,
              }}
            >
              {f.label}
            </button>
          );
        })}
      </div>

      {/* Employer type-ahead */}
      <div style={{ position: 'relative', marginTop: 8 }}>
        <input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          spellCheck={false}
          placeholder="Filter by employer…"
          aria-label="Employer"
          style={{
            width: '100%',
            height: 36,
            padding: '0 12px',
            borderRadius: 10,
            border: `1px solid ${BORDER}`,
            background: '#fff',
            color: INK900,
            fontSize: 13,
            outline: 'none',
          }}
        />
        {open && q.length >= 3 && (
          <div
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              top: 40,
              zIndex: 30,
              maxHeight: 220,
              overflowY: 'auto',
              background: '#fff',
              border: `1px solid ${BORDER}`,
              borderRadius: 10,
              boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
            }}
          >
            {loading ? (
              <div style={{ padding: '10px 12px', fontSize: 12, color: INK400 }}>Searching…</div>
            ) : options.length === 0 ? (
              <div style={{ padding: '10px 12px', fontSize: 12, color: INK400 }}>No matches for “{q}”.</div>
            ) : (
              options.map((o) => {
                const on = employerSet.has(o.employer_norm);
                return (
                  <button
                    key={o.employer_norm}
                    type="button"
                    onMouseDown={(e) => e.preventDefault()} // keep focus so onBlur doesn't close before the click
                    onClick={() => toggleEmployer(o.employer_norm)}
                    style={{
                      display: 'flex',
                      width: '100%',
                      alignItems: 'center',
                      gap: 8,
                      padding: '9px 12px',
                      border: 'none',
                      background: on ? CHIP_BG : '#fff',
                      color: INK900,
                      fontSize: 13,
                      textAlign: 'left',
                      cursor: 'pointer',
                    }}
                  >
                    <span
                      style={{
                        width: 14,
                        color: TEAL900,
                        fontWeight: 700,
                        visibility: on ? 'visible' : 'hidden',
                      }}
                    >
                      ✓
                    </span>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {o.employer_name ?? o.employer_norm}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        )}
      </div>

      {/* Selected employer chips */}
      {employers.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
          {employers.map((v) => (
            <span
              key={v}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                padding: '3px 6px 3px 10px',
                borderRadius: 8,
                background: CHIP_BG,
                color: INK900,
                fontSize: 12,
                fontWeight: 600,
                maxWidth: '100%',
              }}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {displayRef.current.get(v) ?? v}
              </span>
              <button
                type="button"
                aria-label={`Remove ${displayRef.current.get(v) ?? v}`}
                onClick={() => toggleEmployer(v)}
                style={{ border: 'none', background: 'transparent', color: INK400, cursor: 'pointer', fontSize: 14, lineHeight: 1 }}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
