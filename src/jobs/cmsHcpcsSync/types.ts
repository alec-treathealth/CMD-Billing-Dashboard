/**
 * Shared types for the quarterly CMS HCPCS sync (src/jobs/cmsHcpcsSync).
 *
 * The sync is split into a PURE core (parse / filter / diff — no I/O, fully unit
 * tested against fixtures) and thin I/O adapters (cmsSource for fetch+unzip, db for
 * node-postgres). These types are the seam between them.
 *
 * NON-PHI: nothing here carries patient data — HCPCS codes + descriptions only.
 */

/** One HCPCS code as extracted from a CMS quarterly Alpha-Numeric file. */
export interface HcpcsRecord {
  /** 5-char alphanumeric HCPCS Level II code, upper-cased, trimmed (e.g. "H0018"). */
  code: string;
  /** Short description (may be empty in the source for some records). */
  shortDesc: string;
  /** Long description, or null when the source leaves it blank. */
  longDesc: string | null;
  /** CMS "added" / effective date if the layout carries one, else null. */
  effectiveDate: string | null;
}

/** The prior state of a tracked HCPCS code, read from code_intel.ref_code. */
export interface RefCodeSnapshotRow {
  code: string;
  shortDesc: string;
  longDesc: string | null;
  isActive: boolean;
}

export type ChangeType = 'code_added' | 'code_revised' | 'code_deleted';

/** A detected change, ready to become a code_intel.policy_change_event row. */
export interface CodeChangeEvent {
  code: string;
  changeType: ChangeType;
  changeSummary: string;
  previousValue: Record<string, unknown> | null;
  newValue: Record<string, unknown> | null;
  effectiveDate: string | null;
}

/** Non-PHI result summary returned by runCmsHcpcsSync (safe to log / return to cron). */
export interface CmsSyncSummary {
  enabled: boolean;
  sourceRef: string | null;
  fetchedUrl: string | null;
  totalRecords: number;
  bhRecords: number;
  added: number;
  revised: number;
  deleted: number;
  refCodesUpserted: number;
  eventsInserted: number;
  dryRun: boolean;
}
