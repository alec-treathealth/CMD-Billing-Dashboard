# monday Census Board Architecture — measured registry

**Measured live 2026-08-05** via the monday GraphQL API across **all three** workspaces on
the `indigobilling` account, and against the live `collections.facilities` /
`collections.cmd_facility_aliases` / `collections.qualify_facility_census` tables
(Supabase project `dbpabchpvipipkzkogta`).

Every board id, column id, formula body, item count and facility code below was read from
the live API/DB. Where something is *not* verified it says so.

---

## 1. There are 30 census boards, across two workspaces

`discoverWorkspaceBoards` (`src/collections/qualifyCensusSync.ts`) issues
`boards(workspace_ids: $ws, limit: 100)` with **no `page` argument**, against **one**
workspace id.

Two independent blind spots follow:

**Page cap.** `A. Admissions (Main)` (id `2613676`) holds **128 boards**. Page 1 in default
order returns the 100 newest; page 2 returns the remaining 28 — and page 2 is where **all
ten of the oldest census boards live** (AMH, Pacific, Opus, Revival, Tennessee Behavioral,
CAMH, SVR, Hillside, Nashville MH, Lonestar MH), plus the Facility Info board. A prior
discovery run concluded "CAMH, PCMH, TBH have no discovered board"; all three boards exist
(`7047313870`, `7046603503`, `7047312296`). The absence was the cap, not the data.

**Single-workspace scope.** The `MHC PHP/IOP` workspace (id `1717903`) holds two more live
census boards. They are invisible to a discovery pass over `2613676` alone.

Census-board census:

| | count |
|---|---|
| `A. Admissions (Main)` — residential family | 14 |
| `A. Admissions (Main)` — outpatient family | 14 |
| `MHC PHP/IOP` — MHC of San Diego, one per family | 2 |
| **total real census boards** | **30** |

(A source comment in `qualifyCensus.ts` says 13 + 14 = 27 across one workspace. The 14th
residential board, `North California MH Admissions Census`, was created after that recon.)

### Deliberately excluded

| board_id | name | why |
|---|---|---|
| `2968782313` | MHC Outpatient Census (1,099 items) | 2023-vintage schema. `Actual Adm` not `ADM Date`, DC on `date9`, **no** `Total Auth Days`, **no** `Next UR Date`, **no** LOS column. Member of neither family. |
| `2968782440` | MHC Outpatient UR | not a census board |
| `9947448656` / `9947456861` | Demo Final RTC / OP Admissions Census | demo workspace `12357386`, private |
| `*` | `Subitems of …` boards | already filtered by `board_kind != 'sub_item_board'` |

---

## 2. Two board families — and their LOS formulas are NOT the same

Both families compute LOS in a monday **formula** column. monday's API returns
`text: ""` for every formula column, so LOS is unreadable over the API on all 30 boards.
The inputs (`Admit Status`/`Status`, `ADM Date`, `DC Date`) are plain status/date columns
and read fine.

Formula bodies read from `columns.settings_str` on **all 30 boards**:

**Residential (15 boards) — has `+1`:**
```
IF({status} = "Discharged", Add(ROUND(DAYS({dc}, {adm}), 0), 1), ROUND(DAYS(TODAY(), {adm}), 0))
```

**Outpatient (15 boards) — has NO `+1`:**
```
IF({status} = "Discharged", ROUND(DAYS({dc}, {adm}), 0), ROUND(DAYS(TODAY(), {adm}), 0))
```

Identical on every board within a family, modulo per-board column ids. **A single LOS
expression applied to both families is wrong on 15 boards.** The replacement must be
family-dependent:

```
losDays(family, status, adm, dc, today):
  if adm is null                        -> null
  if status == 'Discharged':
      if dc is null                     -> null
      d = daysBetween(adm, dc)
      return family == 'residential' ? d + 1 : d
  return daysBetween(adm, today)
```

`daysBetween` must be whole-day UTC-date arithmetic (monday `DAYS()` semantics), and
`today` must stay the existing `America/Chicago` value from `runQualifyCensusSync`.

### Family must be determined structurally, not from the LOS column title

`MHC of San Diego OP Admissions Census` (`9947459669`) has its LOS column **titled
`Days in RTC`** — but its column id is the outpatient-template `formula_mkv84ycs`, its
status input is the outpatient `color_mkv83mx8`, and its formula body has **no `+1`**.
Structure and semantics say outpatient; the title lies.

Reliable structural discriminators:

| | residential | outpatient |
|---|---|---|
| status column title | `Admit Status` | `Status` |
| also present | `Lost Auth Days`, `Beds` (auto_number) | `LOC`, `#` (auto_number) |
| `IQ` | usually (absent on MHC Residential) | never |

`IQ` is **not** universal to residential — `7593076989` MHC Residential has no `IQ`
column. Don't use it as a discriminator.

Useful side effect of computing LOS: once the formula column is no longer read, its title
stops mattering, so the LOS title should come out of `CENSUS_TITLES` entirely and the
`Days in RTC` mislabel on the MHC OP board becomes harmless.

Related, out of scope: `Lost Auth Days` (residential only) is
`MINUS({Total Auth Days}, {Days in RTC})` — a formula whose input is a formula, so also
API-empty. Nothing reads it today.

---

## 3. Per-board column registry (measured)

`ADM Date` is column id `date` on **all 30 boards**. `Total Auth Days` is a `numbers`
column on all 30. Everything else varies — resolve by title, never by id.

### Residential — `Admit Status`

| board_id | board name | facility_code | care_setting | items | status id | DC Date id | LOS formula id | auth id | UR date id |
|---|---|---|---|---|---|---|---|---|---|
| 7046603503 | Pacific Admissions Census | `PCMH` | IP | 145 | `admit_status___1` | `date__1` | `formula_mkt29g1z` | `numeric_mkt28v08` | `date_mkt2cdye` |
| 7046827887 | Opus Admissions Census | `10021573` | IP | 456 | `status6__1` | `date__1` | `formula_mkt2v3eq` | `numeric_mkszg11p` | `date_mkszq6w2` |
| 7047309383 | Revival Admissions Census | `10028595` | IP | 264 | `admit_status___1` | `date__1` | `formula_mkt2xqzk` | `numeric_mkt26e8x` | `date_mkt2hxr5` |
| 7047312296 | Tennessee Behavioral Admissions Census | `TBH` | IP | 229 | `admit_status___1` | `date4` | `formula_mkt2xapc` | `numeric_mkt2pg64` | `date_mkt2w99a` |
| 7047313870 | CAMH Admissions Census | `CAMH` | IP | 279 | `admit_status___1` | `date4` | `formula_mkt2b5kt` | `numeric_mkt2jx73` | `date_mkt27jwj` |
| 7047316556 | SVR Admissions Census | `10025950` | IP | 372 | `status6__1` | `date4` | `formula_mkt2r1y6` | `numeric_mkt297v5` | `date_mkt23spv` |
| 7047322890 | Hillside Admissions Census | `10026624` | IP | 288 | `status6__1` | `date__1` | `formula_mkt242bg` | `numeric_mkt2qnc2` | `date_mkt23m66` |
| 7422342993 | Nashville MH Admissions Census | `NASH` *(mapped)* | IP | 233 | `admit_status___1` | `date4` | `formula_mkt2dqph` | `numeric_mkt2rb5c` | `date_mkt28z4m` |
| 8401390206 | Lonestar MH Admissions Census | `LSMH` *(mapped)* | IP | 175 | `admit_status___1` | `date4` | `formula_mkt2bdqf` | `numeric_mkt2shja` | `date_mkt2exhh` |
| 18358664283 | LAMH Admissions Census | `LAMH` | IP | 59 | `admit_status___1` | `date__1` | `formula_mkt29g1z` | `numeric_mkt28v08` | `date_mkt2cdye` |
| 18394268482 | Dallas MH Admissions Census | `DMH` | IP | 83 | `admit_status___1` | `date4` | `formula_mkt2bdqf` | `numeric_mkt2shja` | `date_mkt2exhh` |
| 18400080863 | Kentucky WC Admissions Census | `KWC` | IP | 74 | `admit_status___1` | `date4` | `formula_mkt2bdqf` | `numeric_mkt2shja` | `date_mkt2exhh` |
| 18419837532 | Wellness Recovery Admissions Census | **BLOCKED** | — | 7 | `admit_status___1` | `date__1` | `formula_mkt29g1z` | `numeric_mkt28v08` | `date_mkt2cdye` |
| 18424928550 | North California MH Admissions Census | **BLOCKED** | — | 6 | `admit_status___1` | `date4` | `formula_mkt2b5kt` | `numeric_mkt2jx73` | `date_mkt27jwj` |
| 7593076989 | MHC of San Diego  Residential Admissions Census | **DEFERRED** `10024431` | BOTH | 485 | `admit_status___1` | `date4` | `formula_mkv71g1s` | `numeric_mkv75wtc` | `date_mkv7qh9q` |

Note the id collisions across *different* boards (`formula_mkt29g1z` on Pacific, LAMH and
Wellness Recovery; `formula_mkt2bdqf` on Lonestar, Dallas and Kentucky) — cloned boards
reuse ids, so an id is not a board identity. Title resolution stays correct.

### Outpatient — `Status` + `LOC`

Fourteen of the fifteen carry **identical** column ids (clones of one template):

| logical | column id |
|---|---|
| status | `color_mkv83mx8` |
| ADM Date | `date` |
| DC Date | `date4` |
| LOS formula | `formula_mkv84ycs` |
| Total Auth Days | `numeric_mkv83e3h` |
| Next UR Date | `date_mkv868th` |

| board_id | board name | facility_code | care_setting | items | notes |
|---|---|---|---|---|---|
| 6974268840 | AMH Admissions Census | `10029528` | OP | 156 | |
| 9933183210 | FRCA Admissions Census | `FRCA` | OP | 41 | |
| 9976711362 | Treat MH CA Admissions Census | `TREAT_CA` | OP | 398 | |
| 9976791377 | Treat MH TX Admissions Census | `TREAT_TX` | OP | 420 | |
| 9977175215 | Treat MH TN Admissions Census | `TREAT_TN` | OP | 226 | |
| 9977210222 | Treat MH WA Admissions Census | `TREAT_WA` | OP | 159 | |
| 9977268128 | Treat MH NV Admissions Census | `TREAT_NV` | OP | 83 | |
| 18391657878 | MY Teen Admissions Census | `10034230` | OP | 20 | only census board with **no** `Connection Id` column |
| 18393561198 | Modesto MH Admissions Census | `10030319` | OP | 130 | |
| 18394268978 | Telehealth MH Admissions Census | `TELEHEALTH_MH` | OP | 53 | rollup member — see §4 |
| 18404698218 | Teen MH Texas  Admissions Census | `TEEN_MH_TX` | OP | 24 | double space in board name; match on board_id |
| 18405687473 | Telehealth MH Texas Admissions Census | `TELEHEALTH_MH` | OP | 39 | rollup member — see §4 |
| 18407820613 | Treat MH VA Admissions Census | **BLOCKED** | — | 1 | |
| 18422175778 | Treat MH CO Admissions Census | **BLOCKED** | — | 2 | |
| 9947459669 | MHC of San Diego OP Admissions Census | **DEFERRED** `10024431` | BOTH | 161 | LOS column **titled `Days in RTC`** — see §2 |

---

## 4. Board → facility is N:1, not 1:1

Two independent rollups exist. `qualify_facility_census.facility_code` is a bare
`text primary key`, so N boards → 1 code means the second upsert **overwrites** the first
(last-write-wins) rather than aggregating. Onboarding only one board of a set silently
undercounts instead.

**Telehealth MH — 2 boards, same family, ONE CMD account.**
`Telehealth MH` is the parent company of each `Telehealth MH [state]`; the state entities
do not appear in CMD. All of them bill under account **`10034666`** = `TELEHEALTH_MH`.
Because both boards are outpatient, item-level aggregation across the set is sound and
needs no schema change: concatenate items from both boards, then aggregate once. More
state boards are expected, so the config shape must be facility → board[].

**MHC of San Diego — 2 boards, one per family, `care_setting = 'BOTH'`.**
`10024431` MENTAL HEALTH CENTER OF SAN DIEGO has a residential board and an outpatient
board. Aggregating them into one `avg_los_days` averages two different quantities (RTC LOS
carries the `+1`, OP LOS does not), so this needs the census grain to become
`(facility_code, board_family)` — a migration plus a read-path change in
`ratingV2.ts` / `app/lib/qualify/core.ts`. **Deferred to its own scoped change.**

### Never a rollup: Treat MH

Treat is structurally the opposite of Telehealth — **one CMD account per state**:
`TREAT_CA` 10030101, `TREAT_TX` 10029722, `TREAT_TN` 10029905, `TREAT_WA` 10031212,
`TREAT_NV` 10034671. There is **no Treat parent row** in `collections.facilities` (no
`TREAT_NATIONAL`, nothing named `TREAT MENTAL HEALTH NATIONAL`; the 0-bed "Treat Mental
Health National" item on the Facility Info board has no roster counterpart). A parent
census row would be an island — nothing in collections or claims would join to it.
**Ruling 2026-08-05: Treat MH VA and Treat MH CO stay blocked until each gets its own CMD
account.**

---

## 5. Facility codes: the roster mixes two keying conventions

`collections.facilities` holds **48 rows** (live count) under two conventions, and the
census map must use both verbatim:

- **BXR facilities → mnemonic codes**: `CAMH`, `PCMH`, `TBH`, `LAMH`, `NASH`, `KWC`,
  `FRCA`, `LSMH`, `DMH`, `TREAT_CA/NV/TN/TX/WA`, `TEEN_MH_TX`, `TELEHEALTH_MH`.
- **Indigo facilities → 8-digit CMD customer ids**: `10021573` (OPUS HEALTH),
  `10024431` (MENTAL HEALTH CENTER OF SAN DIEGO), `10025950` (SILICON VALLEY RECOVERY,
  LLC), `10026624` (HILLSIDE HORIZON FOR TEENS), `10028595` (REVIVAL MENTAL HEALTH),
  `10029528` (ADOLESCENT MENTAL HEALTH), `10030319` (MENTAL HEALTH MODESTO),
  `10034230` (MY TEEN MENTAL HEALTH).

A mnemonic-only search of the roster finds no code for Opus / Revival / SVR / Hillside /
AMH / Modesto / MY Teen / MHC and reads as "operator must name these". They already have
codes; the codes are 8-digit. **Match on `facility_name`, not on code shape.**

`TEEN_MH_TX` and `TELEHEALTH_MH` are both live and both real (`TEEN_MH_TX` =
`TEEN MENTAL HEALTH TEXAS`, account `10035166`, seeded by 0072; `TELEHEALTH_MH` =
`Telehealth MH`, account `10034666`, seeded by 0007). The live `cmd_facility_aliases` row
for `TEEN MENTAL HEALTH TEXAS LLC` points at `TEEN_MH_TX`, not `TREAT_TX` — 0072 is
applied. Verified by direct query.

`display_acronym` is populated for all 16 mnemonic facilities and **NULL** for every
8-digit Indigo facility. Any label sourced from it needs a `facility_name` fallback.

### Free invariant: board family ⟺ care_setting

On all 24 boards with a live roster row, `family == 'residential'` ⟺ `care_setting == 'IP'`
and `family == 'outpatient'` ⟺ `care_setting == 'OP'`, with zero exceptions. The only
`BOTH` facility is `10024431` (MHC), which is exactly the facility with one board of each
family. Worth asserting in the census run report: a violation means a board was mapped to
the wrong facility.

### The 4 blocked boards

| board | board_id | blocker |
|---|---|---|
| North California MH | 18424928550 | `10035913` / `NORTHERN CALIFORNIA MENTAL HEALTH` is in the `0034_indigo_facilities_seed.sql` **file** but **not in the live table** (verified: `count = 0`). File↔live drift — resolve before mapping. |
| Wellness Recovery | 18419837532 | `WELLNESS RECOVERY CENTER LLC`, CMD **#10033951** — named in the 0006 header as a known-but-unseeded account. Never seeded. |
| Treat MH VA | 18407820613 | No roster row, no CMD account. Per §4, no parent to roll into. |
| Treat MH CO | 18422175778 | No roster row, no CMD account. Per §4, no parent to roll into. |

`qualify_facility_census.facility_code` has **no FK** to `collections.facilities`
(verified in `0078_qualify_facility_census.sql`), so an unrostered code would not error —
it would write an orphan row that never joins to a ranking row. That is the failure mode
to avoid: block explicitly, don't write and hope.

---

## 6. Current live state of the sync

`collections.qualify_facility_census` holds exactly two rows:

| facility_code | avg_auth_days | avg_los_days |
|---|---|---|
| `LSMH` | 21.11 | **NULL** |
| `NASH` | 25.17 | **NULL** |

`avg_los_days` is NULL for both because the LOS source is the API-empty formula column.
`ratingV2.ts` makes the auth/LOS factor unavailable when either input is null, so the
factor is dead for every facility — including the two instrumented ones. Auth data is
fine; only LOS is missing, and the current "no authorization / length-of-stay data"
message misstates which one.

Conformance currently reports `conformance_gap_boards: 0` because `resolveCensusColumns`
asserts **title presence** only. A 100%-empty column passes. The check needs a
value-presence assertion to be worth anything.

---

## 7. Disposition of all 30 boards

| disposition | boards | facilities |
|---|---|---|
| onboard now | 24 | 23 (`TELEHEALTH_MH` from 2 boards; `NASH` + `LSMH` already mapped → **21 new**) |
| blocked on roster | 4 | — |
| deferred (needs census re-grain) | 2 | 1 (`10024431`) |
| **total** | **30** | |
