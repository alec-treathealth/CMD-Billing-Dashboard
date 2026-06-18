'use client';

/**
 * Behavioral Health Code Reference (Phase 9) — a read-only, client-filtered
 * lookup table of HCPCS/CPT + Revenue Code combinations for BH billing.
 *
 * There is NO data access here: the dataset is a static, non-PHI constant baked
 * into the bundle (no API route, no Supabase query). Filtering and the text
 * search are pure client-side view state over that constant — nothing is fetched
 * or persisted. Citations link out to the cited source manuals in a new tab.
 */
import { useMemo, useState } from 'react';
import { ChevronDown, ExternalLink, Search } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

type CodeReferenceRow = {
  setting: string;
  revenueCode: string;
  hcpcs: string;
  service: string;
  source: string;
  notes: string;
  citationLabel: string;
  citationUrl: string;
};

const codeReferenceData: CodeReferenceRow[] = [
  {
    setting: 'PHP/OP',
    revenueCode: '0900',
    hcpcs: '90791, 90792',
    service: 'BH Assessment / Intake',
    source: 'CMS',
    notes: 'Required on same claim line; repeat rev code per HCPCS if multiple',
    citationLabel: 'CMS PHP Billing Article',
    citationUrl:
      'https://www.cms.gov/medicare-coverage-database/view/article.aspx?articleId=57053&ver=21',
  },
  {
    setting: 'PHP/OP',
    revenueCode: '0900',
    hcpcs: '97153, 97154, 97155, 97156, 97157, 97158',
    service: 'ABA Therapy (Applied Behavior Analysis)',
    source: 'CMS',
    notes: 'Added Dec 2025 expansion; verify payer coverage',
    citationLabel: 'CMS PHP Billing Article',
    citationUrl:
      'https://www.cms.gov/medicare-coverage-database/view/article.aspx?articleId=57053&ver=21',
  },
  {
    setting: 'PHP/OP',
    revenueCode: '0914',
    hcpcs: '90785, 90832, 90833, 90834, 90836, 90837, 90838, 90839, 90840, 90845, 90865, 90880, 90899',
    service: 'Individual Psychotherapy',
    source: 'CMS',
    notes: '90785 is add-on code for interactive complexity; use with primary procedure',
    citationLabel: 'Ensora PHP Billing Guide (updated May 2026)',
    citationUrl: 'https://ensorahealth.com/blog/php-billing-codes-every-facility-should-know/',
  },
  {
    setting: 'PHP/OP',
    revenueCode: '0915',
    hcpcs: 'G0410, G0411, 90849',
    service: 'Group Psychotherapy',
    source: 'CMS',
    notes:
      'G0410 = 45–50 min standard group; G0411 = 45–50 min interactive group; 90849 = multiple-family group',
    citationLabel: 'CMS PHP Billing Article',
    citationUrl:
      'https://www.cms.gov/medicare-coverage-database/view/article.aspx?articleId=57053&ver=21',
  },
  {
    setting: 'PHP/OP',
    revenueCode: '0916',
    hcpcs: '90846, 90847',
    service: 'Family Psychotherapy',
    source: 'CMS',
    notes: '90846 = without patient; 90847 = with patient',
    citationLabel: 'Ensora PHP Billing Guide (updated May 2026)',
    citationUrl: 'https://ensorahealth.com/blog/php-billing-codes-every-facility-should-know/',
  },
  {
    setting: 'PHP/OP',
    revenueCode: '043X',
    hcpcs: 'G0129',
    service: 'Occupational Therapy',
    source: 'CMS',
    notes: 'G0129 = OT by qualified OT, per 45-min session; only bill under PHP',
    citationLabel: 'CMS Transmittal A01-111',
    citationUrl:
      'https://www.cms.gov/regulations-and-guidance/guidance/transmittals/downloads/a01111.pdf',
  },
  {
    setting: 'PHP/OP',
    revenueCode: '0904',
    hcpcs: 'G0176',
    service: 'Activity Therapy (music, dance, art, play)',
    source: 'CMS',
    notes:
      'Do NOT bill G0176 or rev code 0904 unless billing under PHP (condition code 41 required)',
    citationLabel: 'CMS Transmittal A01-111',
    citationUrl:
      'https://www.cms.gov/regulations-and-guidance/guidance/transmittals/downloads/a01111.pdf',
  },
  {
    setting: 'PHP/OP',
    revenueCode: '0918',
    hcpcs: '96100, 96112, 96113, 96115, 96116, 96117, 96121',
    service: 'Psychiatric / Neuropsychological Testing',
    source: 'CMS',
    notes:
      '96112/96113 = developmental assessment; 96116/96121 = neurobehavioral status exam',
    citationLabel: 'Ensora PHP Billing Guide (updated May 2026)',
    citationUrl: 'https://ensorahealth.com/blog/php-billing-codes-every-facility-should-know/',
  },
  {
    setting: 'PHP/OP',
    revenueCode: '0942',
    hcpcs: 'G0177',
    service: 'Patient Education / Training for Psychiatric Purposes',
    source: 'CMS',
    notes:
      'Must report BOTH rev code 0942 AND G0177 per Medicare Intermediary Manual §3651 and §3661',
    citationLabel: 'CMS Transmittal A01-111',
    citationUrl:
      'https://www.cms.gov/regulations-and-guidance/guidance/transmittals/downloads/a01111.pdf',
  },
  {
    setting: 'PHP/OP',
    revenueCode: '0912 or 0913',
    hcpcs: 'H0035, S9475',
    service: 'PHP Per Diem — Non-Medicare Payers',
    source: 'Payer-Specific',
    notes: '0912 = less intensive PHP; 0913 = intensive PHP; pair with bill type 131 on UB-04',
    citationLabel: 'Ensora PHP Billing Guide (updated May 2026)',
    citationUrl: 'https://ensorahealth.com/blog/php-billing-codes-every-facility-should-know/',
  },
  {
    setting: 'IOP',
    revenueCode: '0905, 0906',
    hcpcs: 'H0015, H0035, S9480',
    service: 'Intensive Outpatient Program',
    source: 'CMS / Payer-Specific',
    notes:
      'H0015 = alcohol/drug SUD IOP per diem; H0035 = mental health PHP/IOP <24hr; S9480 = IOP per diem commercial',
    citationLabel: 'Novitas IOP Billing Requirements',
    citationUrl:
      'https://www.novitas-solutions.com/webcenter/portal/MedicareJH/pagebyid?contentId=00284581',
  },
  {
    setting: 'IOP',
    revenueCode: '0914',
    hcpcs: '90832, 90834, 90837',
    service: 'Individual Therapy (IOP)',
    source: 'CMS',
    notes: 'Same individual therapy codes apply at IOP level of care',
    citationLabel: 'Novitas IOP Billing Requirements',
    citationUrl:
      'https://www.novitas-solutions.com/webcenter/portal/MedicareJH/pagebyid?contentId=00284581',
  },
  {
    setting: 'IOP',
    revenueCode: '0915',
    hcpcs: 'G0410, G0411',
    service: 'Group Therapy (IOP)',
    source: 'CMS',
    notes: 'Same group codes used in IOP as PHP',
    citationLabel: 'Novitas IOP Billing Requirements',
    citationUrl:
      'https://www.novitas-solutions.com/webcenter/portal/MedicareJH/pagebyid?contentId=00284581',
  },
  {
    setting: 'IOP',
    revenueCode: '0916',
    hcpcs: '90846, 90847',
    service: 'Family Therapy (IOP)',
    source: 'CMS',
    notes: '—',
    citationLabel: 'Novitas IOP Billing Requirements',
    citationUrl:
      'https://www.novitas-solutions.com/webcenter/portal/MedicareJH/pagebyid?contentId=00284581',
  },
  {
    setting: 'IOP',
    revenueCode: '0918',
    hcpcs: '96116, 96121',
    service: 'Behavioral Health Testing (IOP)',
    source: 'CMS',
    notes: '—',
    citationLabel: 'Novitas IOP Billing Requirements',
    citationUrl:
      'https://www.novitas-solutions.com/webcenter/portal/MedicareJH/pagebyid?contentId=00284581',
  },
  {
    setting: 'IP Psych',
    revenueCode: '0114, 0124',
    hcpcs: '(Per diem — no line-level HCPCS required)',
    service: 'Inpatient Psychiatric — All-Inclusive Per Diem',
    source: 'CMS',
    notes:
      'Inpatient psych is billed as per diem; individual HCPCS codes are bundled and not reported separately',
    citationLabel: 'NUBC UB-04 Manual',
    citationUrl: 'https://www.nubc.org',
  },
  {
    setting: 'IP Detox',
    revenueCode: '0126',
    hcpcs: 'H0008, H0010',
    service: 'Detoxification Services (ASAM 3.7 / 4.0)',
    source: 'Payer-Specific',
    notes:
      'H0008 = alcohol detox services; H0010 = alcohol and drug detox; verify with Optum and BCBS payer manuals',
    citationLabel: 'Behave Health HCPCS Glossary',
    citationUrl: 'https://behavehealth.com/glossary/hcpcs-codes',
  },
  {
    setting: 'Residential',
    revenueCode: '1000, 1002',
    hcpcs: '(Varies by payer)',
    service: 'Residential Treatment Center (RTC)',
    source: 'Payer-Specific',
    notes:
      "No universal HCPCS standard — must confirm with each payer's behavioral health carve-out manual",
    citationLabel: 'NUBC UB-04 Manual',
    citationUrl: 'https://www.nubc.org',
  },
];

const SETTING_OPTIONS = ['PHP/OP', 'IOP', 'IP Psych', 'IP Detox', 'Residential'] as const;
const SOURCE_OPTIONS = ['CMS', 'NUBC', 'Payer-Specific'] as const;

/**
 * Shared native-select styling (mirrors the Claims Explorer control). `appearance-none`
 * strips the platform chevron so we can render our own; teal focus ring ties it to the brand.
 */
const CONTROL_CLASS =
  'h-10 w-full cursor-pointer appearance-none truncate rounded-md border border-line bg-surface pl-3 pr-9 text-sm text-ink900 ring-offset-background transition-colors hover:border-teal200 focus-visible:border-teal500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal500/40 focus-visible:ring-offset-1';

/** A labelled facet dropdown with a custom chevron (native select stays accessible). */
function SelectField({
  id,
  label,
  value,
  onChange,
  children,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-[11px] font-medium uppercase tracking-wide text-ink400">
        {label}
      </Label>
      <div className="relative">
        <select id={id} className={CONTROL_CLASS} value={value} onChange={(e) => onChange(e.target.value)}>
          {children}
        </select>
        <ChevronDown
          aria-hidden
          className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink400"
        />
      </div>
    </div>
  );
}

export function CodeReference() {
  const [setting, setSetting] = useState('');
  const [source, setSource] = useState('');
  const [query, setQuery] = useState('');

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return codeReferenceData.filter((row) => {
      if (setting && row.setting !== setting) return false;
      // Source values can be combined (e.g. "CMS / Payer-Specific"); match as a substring
      // so a "CMS" or "Payer-Specific" filter still surfaces the combined rows.
      if (source && !row.source.includes(source)) return false;
      if (q) {
        const haystack = `${row.revenueCode} ${row.hcpcs} ${row.service}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [setting, source, query]);

  return (
    <div className="space-y-4">
      {/* Filter bar — pure client-side view state over the static dataset. */}
      <div className="grid items-end gap-x-4 gap-y-3 rounded-lg border border-line bg-card p-4 shadow-ths sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,2fr)]">
        <SelectField id="cr-setting" label="Setting" value={setting} onChange={setSetting}>
          <option value="">All settings</option>
          {SETTING_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </SelectField>
        <SelectField id="cr-source" label="Source" value={source} onChange={setSource}>
          <option value="">All sources</option>
          {SOURCE_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </SelectField>
        <div className="space-y-1">
          <Label htmlFor="cr-search" className="text-[11px] font-medium uppercase tracking-wide text-ink400">
            Search
          </Label>
          <div className="relative">
            <Search
              aria-hidden
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink400"
            />
            <Input
              id="cr-search"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search revenue code, HCPCS/CPT, or service…"
              className="pl-9"
            />
          </div>
        </div>
      </div>

      <div className="text-sm text-muted-foreground">
        {rows.length === codeReferenceData.length
          ? `${codeReferenceData.length} code combinations`
          : `${rows.length} of ${codeReferenceData.length} code combinations`}
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              {['Setting', 'Revenue Code', 'HCPCS / CPT Code(s)', 'Service Description', 'Source', 'Notes', 'Citation'].map(
                (h) => (
                  <TableHead key={h} className="text-[11px] font-semibold uppercase tracking-wide text-ink400">
                    {h}
                  </TableHead>
                ),
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="py-10 text-center text-sm text-muted-foreground">
                  No code combinations match these filters. Try widening or clearing them.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row, i) => (
                <TableRow key={`${row.setting}-${row.revenueCode}-${i}`} className="align-top transition-colors hover:bg-teal50/50">
                  <TableCell>
                    <Badge variant="default" className="whitespace-nowrap">
                      {row.setting}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-mono text-[13px] tabular-nums">{row.revenueCode}</TableCell>
                  <TableCell className="whitespace-normal font-mono text-[13px] tabular-nums">
                    {row.hcpcs}
                  </TableCell>
                  <TableCell className="whitespace-normal text-ink900">{row.service}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className="whitespace-nowrap">
                      {row.source}
                    </Badge>
                  </TableCell>
                  <TableCell className="max-w-[22rem] whitespace-normal text-[13px] text-ink600">
                    {row.notes}
                  </TableCell>
                  <TableCell>
                    <a
                      href={row.citationUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 whitespace-nowrap text-[13px] text-teal700 underline underline-offset-2 transition-colors hover:text-teal500"
                    >
                      {row.citationLabel}
                      <ExternalLink aria-hidden className="h-3 w-3 shrink-0" />
                    </a>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
