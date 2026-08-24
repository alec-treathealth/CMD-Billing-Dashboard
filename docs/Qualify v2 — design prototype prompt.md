# Qualify v2 — design prototype prompt

Paste the block below into a fresh Claude conversation (Sonnet 5 or Opus 5). It produces a single interactive React artifact — clickable, fake data, all states reachable — so you can feel the flow before committing to the build.

**Why a prototype first:** three things in this design are invisible on paper and obvious in your hands — whether the auto-window decision feels magic or opaque, whether the scorecard's "show your work" is legible or a wall, and whether the amounts-blind view is genuinely usable for an admissions rep or a crippled version of the real one. Those are the questions to answer before Phase 1.

**How to use it:** run it once, click through, then iterate in the same conversation ("the factor list is too dense," "make the streaming slower," "show me the insufficient-sample state"). Don't try to get it perfect in one shot.

---

```
You are designing the front end for an internal healthcare tool. I want a
high-fidelity, clickable prototype as a single React artifact so I can feel the
interaction before we build it for real. Fake data throughout — no backend.

## What this screen is

"Qualify" is used by an admissions rep at a behavioral-health treatment company.
A prospective client calls. The rep has their insurance card. Before admitting,
the rep needs to know: **does this payer actually pay us, and at which of our
facilities?**

Today that answer lives in a biller's head. This screen is the attempt to put it
in the rep's hands in under ten seconds.

The rep is not financially sophisticated and is often on the phone while using
this. Speed and legibility beat completeness. A confident wrong answer is worse
than an honest "not enough data."

## The flow, in order

1. **Empty landing.** Two inputs only: a Facility multi-select and a member-ID
   alpha-prefix field (max 5 characters, uppercase, e.g. "XQH" or "YPHAB").
   Above them, a live "ticker" strip of facilities whose scores are trending —
   this is the only thing on screen before a search, and it should make the page
   feel alive rather than empty.

2. **Search + auto-window.** On submit, the system decides its own time window
   rather than asking the rep to pick one. It tries 30 days, then 60, 90, 180,
   365 — stopping at the first window containing at least 10 distinct patients.
   **This decision must be visible, not silent.** Show it resolving (a brief
   stepped animation through the windows it tried), then state the outcome in
   plain language: "Showing trailing 180 days — needed this far back to reach a
   reliable sample." If even 365 days yields under 3 patients, say so and stop;
   do not keep reaching.

3. **The scorecard.** The core of the screen. One card per facility, ranked. Each
   shows a Strong / Watch / Weak verdict and — critically — **its own reasoning,
   expandable.** See the factor list below.

4. **AI explainer.** Under the scorecard, a row of preset prompt chips (not a
   free-text box). Clicking one streams a written explanation in. See below.

5. **Trend chart.** A small chart of the selected facility's rating over the last
   eight periods.

## Design system — use these exact values

Colors (these are real brand tokens, do not substitute):
  teal900  #0E3A3A   page header / darkest surface
  teal700  #135E5A   primary actions, active state
  teal500  #1C8B82   accents, KPI top borders
  teal200  #A8D5D0
  teal50   #EDF6F5
  coral600 #E2674F   the one warm accent — use sparingly, for emphasis
  coral50  #FCEDE8
  ground   #FBF8F4   page background (warm off-white, NOT gray)
  surface  #FFFFFF   card background
  ink900   #1B2B2A   primary text
  ink600   #4A5C5A   secondary text
  ink400   #63756E   tertiary text (this exact value — it's WCAG-AA tuned)
  line     #E4E9E6   borders

Verdict colors:
  Strong (>=50)  green  #1C8B82 on #EDF6F5
  Watch  (30-49) amber  #B7791F on #FEF6E7
  Weak   (<30)   red    #C0503A on #FCEDE8
  Insufficient   neutral #63756E on #F4F2EF — deliberately colorless

Type (load from Google Fonts):
  Space Grotesk — headings, tracking-tight
  Inter — body
  IBM Plex Mono — all numbers, with tabular-nums. Every percentage, count,
    and dollar figure uses this. Numbers must not shift width as they change.
  Fraunces — the one big hero numeral on a scorecard, and only that

Elevation, three tiers only: subtle at rest, one step up on hover, highest for
overlays. A card lifts exactly one tier on hover, never two.

Motion: one easing (ease-out). Fast interactions 150ms. Panel reveals 220ms.
Staggered list entrances at min(index,3) * 60ms — cap the stagger, don't let a
long list cascade forever. Respect prefers-reduced-motion.

Layout: max-width 1680px, generous padding. This is a wide desktop tool.

## The scorecard — this is the part I most need to feel

Per facility, show:

- Facility name + city/state
- **One large Fraunces numeral**: the rating, 0-100
- Verdict pill: Strong / Watch / Weak
- An "evidence" indicator: 4 pips, filled by sample strength
- Distinct patient count and claim line count, de-emphasized
- Care setting tag: IP / OP / Both

Then a **"Why this score" expansion** listing six factors. Each factor is a row
with: an icon, a label, a direction (positive/negative/neutral, color-coded), a
weight percentage, and one line of plain-language detail. Use these six:

  Claims reliability      35%  "62% of billed amount allowed across 47 lines,
                                all confirmed-tier"
  Sample confidence       15%  "11 distinct patients — above the reliability
                                threshold of 10"
  Claim-status mix        20%  "31% of claims still sitting at the payer past
                                90 days"
  Time to resolution      10%  "Median 74 days from service to final payment"
  Market position         10%  "Billing 3.2x the CMS fee-schedule rate for
                                this code set"
  Operational fit         10%  "Avg length of stay 21 days vs 18 authorized"

Show the weights as a thin horizontal stacked bar so the composition is visible
at a glance, not just a list of numbers.

**Also build the insufficient state.** A facility with 2 distinct patients gets
NO color, NO confident percentage, and an explicit "Not enough data to rate —
2 patients in the last 365 days." This state matters as much as the confident
one. Make it feel like honest restraint, not an error.

## Amounts-blind mode — build a toggle for this

Some users (role: "admissions seat") must never see dollar figures. Add a header
toggle to switch between roles so I can compare. In amounts-blind mode, every
dollar amount is **absent from the layout entirely** — not blurred, not masked,
not a gray box. The design must still feel complete and useful without them,
because percentages and counts carry the actual decision. If the blind view
looks broken or obviously lobotomized, the design is wrong and I need to see
that now.

Patient identifiers are always masked as •••••• with a per-row "reveal" action
that shows a small "this access is logged" note.

## The AI explainer

Preset chips: "Explain this score" · "Compare to nearby facilities" · "What would
improve this rating" · "Show me the trend."

On click, stream a response in — actually animate it arriving word by word over
~3 seconds, with a blinking caret. Don't fake it with a spinner then a dump.

The response renders in three labeled sections — TL;DR, Signals, Risks — as
styled components, NOT raw markdown. TL;DR is a short paragraph; Signals and
Risks are bulleted. Write realistic content that references the actual factors
above and hedges appropriately where the sample is thin.

In amounts-blind mode the AI text must also contain no dollar figures.

## Realistic fake data

Facilities: Nashville Mental Health · Pacific Coast Mental Health · Treat Mental
Health Nevada · Kentucky Wellness Center · Lonestar Mental Health · Telehealth MH
· California Mental Health · Dallas Mental Health · Tennessee Behavioral Health ·
Los Angeles Mental Health · First Responders of California

Payers: Aetna · BCBS Tennessee · Cigna · Optum Behavioral Health · Magellan ·
UMR · GEHA · Kaiser Foundation Health Plan

Give the list a realistic spread — two Strong, three Watch, one Weak, one
Insufficient. Ratings should not be suspiciously round numbers.

## Make it reachable

Add a small, unobtrusive state switcher (a dev affordance, visually distinct from
the real UI) so I can jump straight to: empty · resolving-window · results ·
insufficient-data · AI-streaming · AI-complete. I don't want to hunt for states.

## What I do NOT want

- Purple/indigo gradients, glassmorphism, or neon. This is a clinical tool used
  by staff on a phone call, not a landing page.
- Emoji as iconography. Use simple line icons (inline SVG is fine).
- Generic card grids with even padding everywhere — vary density deliberately.
  The verdict should dominate; the supporting numbers should recede.
- A design that only looks good with ideal data. Show me a long facility name, a
  null value, and a thin sample.
- Explanatory helper text under every field. The rep uses this fifty times a day.

## Technical

Single React artifact. Tailwind core utilities only. recharts for the trend
chart. No localStorage or sessionStorage — React state only. No required props.
Use inline SVG for icons.

Prioritize the scorecard and the auto-window disclosure. If you run long,
simplify the trend chart, not those two.
```

---

## After the first pass — questions worth asking it

- "Show me the amounts-blind view side by side with the full view." The gap between them is the real test.
- "Make the insufficient-sample card the first thing I see." If honest restraint reads as a bug, the visual language needs work.
- "The rep is on the phone. Strip anything they wouldn't read in the first three seconds."
- "Show a facility where the factors disagree — strong allowed rate but terrible claim-status mix." That conflict case is where the scorecard earns its keep.

## What to bring back into the build

Whatever survives your click-through becomes the spec for Phase 2 of the build doc. In particular, settle these three from the prototype rather than from the doc:

1. Does the auto-window need a manual override, or is the disclosure enough?
2. How many factors can actually be shown before the card stops being read — six, or fewer with the rest behind an expansion?
3. Is amounts-blind a viable primary experience, or does the admissions role need its own layout rather than a subtraction from this one?
