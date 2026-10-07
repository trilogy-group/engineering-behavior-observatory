# EBO Atlas viewer

Our own shell around Apple's Embedding Atlas npm component (no fork). The unit cloud and the EBO panels
share one DuckDB-WASM database through one Mosaic coordinator, so a brush or filter in the cloud
re-scopes every panel, and a panel can highlight points back in the cloud. The built viewer (`viewer/dist`) ships in
the npm package; `ebo atlas serve --bundle <dir>` shows one Atlas bundle with it.

## Run

```sh
npm ci                                   # from the repository root: installs this workspace too
npm run build && npm run build:viewer    # CLI, then viewer/dist
ebo atlas serve --bundle <bundle-dir>    # http://127.0.0.1:13012 (the cloud needs WebGPU: Chrome, Edge, Safari 26)
npm run smoke --workspace viewer         # against the served bundle; HEADED=1 renders the cloud
```

URL parameters: `bundle` (bundle URL, default `./bundle/`), `panel` (`clusters` | `lanes` | `assessments` | `claims` |
`figures`), `labels` (`facet` = the bundle's cluster labels, `auto` = Embedding Atlas auto-labels with our stop words),
`color` (column the cloud is colored by; default `condition`, `none` for uncolored).

While iterating: `npm run dev --workspace viewer` serves the viewer with hot reload; put a bundle at
`viewer/public/bundle/` or pass `?bundle=<url>` to a served one. Asset names are stable, so a rebuild overwrites
`dist/` in place.

## Bundle files

The viewer reads one bundle directory:

| File | Content |
|---|---|
| `manifest.json` | bundle identity and title |
| `units.arrow` | behavior units: Arrow IPC stream, `row_id` int32 0..n-1, `x`/`y` layout, `neighbors` as `struct<ids: list<int32>, distances: list<float32>>`, `cluster_id` (noise `< 0`, null label), `t0_ms`/`t1_ms`/`timed` |
| `labels.json` | cluster labels (`x`, `y`, `text`, `level`, `priority`); mapped to Embedding Atlas's `content` field, without which a label is silently dropped |
| `lanes.json` | swimlane metadata, cumulative token series, context per model request |
| `assessments.json`, `audit.json`, `claims.json` | judge assessments with native citations, attempt audits, validated claims |
| `native/<attempt>.json` | per-unit native records for the evidence drawer |
| `views.json` | view specs with their build receipts |

Arrow instead of Parquet because DuckDB-WASM would otherwise fetch the parquet extension from extensions.duckdb.org at
runtime (blocked offline and under strict egress). Only the exception-handling DuckDB-WASM build ships: every browser
with WebGPU supports it.

## Commands, state and the URL

Everything that changes on screen is a named command in `src/registry.ts`, with a JSON-schema argument; controls call
commands, and so do fragment links, tests and (later) Agent Mode. A command resolves when the UI has settled and
returns a short description of what changed. Every command emits an event saying whether the user, a URL or an
assistant issued it.

- **State**: the shell and each panel provide their part (`shell`, `clusters`, `lanes`, `assessments`, `claims`,
  `figures`, `drawer`, `cloud`). `getState()` → URL → `setState()` reproduces the screen; `undo` restores the state
  before the last change.
- **URL**: links keep the packet grammar (`#claim=`, `#assessment=`, `#record=<attempt id>:<row id>`, `#audit=`,
  `#chains=`, `#attempt=`, `#view=`); any other state is written as `#state=<base64url JSON>`.
- **Controls**: every control carries `data-ebo-target` (stable target id, `command:argument`) and `data-ebo-command`.
  The smoke test fails when a visible control outside the cloud has no registered command.
- **The cloud**: Embedding Atlas registers its own tools through `modelContext` (chart state, SQL, layouts,
  screenshots). `setViewport`, `selectRange` (rectangle or lasso), `setLegendSelection` and `clearSelection` use its
  `chart_set_state`; `cloudTool` runs any of its tools. A programmatic brush filters the linked panels exactly as a
  drawn one does.
- **Describe**: each panel's `describe()` returns a summary and the numbers it shows, from the same queries it renders.
- `window.ebo` exposes `run`, `commands`, `getState`, `setState`, `describe`, `subscribe` and `listCloudTools`.
- `#assistant` is an empty mount point for the Agent Mode chat panel.

The browser registers the table as `units`. Panels query it with SQL through the shared coordinator.

## Panel 1: clusters × arm

One row per cluster, one column per arm (condition). Within each family (messages, episodes, tools):

- **share**: the arm's units in the cluster ÷ the arm's units in that family
- **expected** E = n_cluster · n_arm,family / n_family (the count if arms were pooled). When the study has more than
  one harness, the default is **Expected from: arms on the same harness**: cluster and family counts are taken within
  the arm's harness, so Grok 4.7 is compared with Grok 4.6 on the same harness rather than with other harnesses'
  tool surfaces (pooled: 60 clusters at |z| ≥ 3, mostly harness vocabulary; within harness: 23; units v0.3, uncapped text)
- **adjusted residual** z = (O − E) / √(E · (1 − n_cluster/n_family) · (1 − n_arm,family/n_family))
- **attempts**: attempts with ≥ 1 unit in the cluster / attempts in the arm

Fill (diverging blue = over, red = under) is drawn only where |z| ≥ 2, with intensity from |log2(O/E)|;
▲/▼ mark |z| ≥ 3. Units inside one attempt are not independent, so z is a ranking aid, not a test;
read the attempt counts before the percentages.

Interactions: brush, lasso or filter in the cloud or its charts → the panel recomputes on that subset.
Click (or Enter on) a row → the cluster's units are highlighted in the cloud; click again to clear.
Hover a cell for O, E, O/E, z and attempts. Family filter, sort (arm difference | size) and CSV export
sit in the panel header.

Verified (opus-5-5-three-arm, tools cluster `grep`): panel values match DuckDB on the parquet —
seatbelt-cnu 1,244 of 5,029 (25%), E 977.4, O/E 1.27, z 13.29, 9/9 attempts (units v0.3, uncapped text; was 1,219 / z 13.20 on v0.2).

## Panel 2: swimlanes and aligned diff (P2)

Data: `lanes.json` (lane metadata, cumulative token series, context per model request) and the units table's
`t0_ms`/`t1_ms`/`timed` (untimed delegation and hook units are placed after the previous timed unit).

One lane per attempt for the selected task, grouped by arm. Rows inside a lane:

- **messages** as ticks; **tool calls** as bars on the elapsed-time axis (or one slot per action on the Steps axis),
  colored by action category (inspect, edit/write, read tool, check, other shell, git, other; fixed order, palette
  validated for light and dark);
- **token ribbon**: context tokens per model request (input + cache read + cache write; shows growth and compaction
  drops) or cumulative tokens; scaled to the largest lane shown. Sources: pi-sdk per-message usage and Codex
  cumulative snapshots from the normalized events; Claude Agent SDK per-message usage from the native `session.jsonl`
  (EBO normalization keeps only the final total; deduplicated per message id, the sums equal the final totals exactly);
  DeepSeek harness reports none;
- **markers**: ✕ error, red underline for failure chains (failure-then-retry, consecutive failures, response to
  failure), grey underline for repeated operations, ▾ units the judge cited, dashed line for each compaction.

The lane header shows cost (when reported), the largest context of one request, duration, tool and error counts and
compactions (┆n); hover it for total tokens and the usage source. Cloud selections dim units outside the selection;
**Show in swimlanes →** in the cluster × arm panel focuses a cluster (other units dimmed, task switched to where the
cluster is most common). Clicking a mark highlights it in the cloud; ◎ highlights the whole attempt.

**Align**: tick two lanes (A, B) and press Align. Actions (tool calls and compactions; messages excluded) are reduced
to signatures (category + command head, plus the target path for reads and edits) and aligned by longest common
subsequence. The view shows the share of actions that align, category counts with B − A bars, the aligned strip
(shared actions faded, one-sided actions at full color, numbered bands for divergent stretches) and the stretches in
sequence order with where each starts in both attempts and what each side did; the five largest are bold. Clicking a
stretch highlights its units in the cloud.

**Trace** downloads a Chrome trace JSON of the task's lanes for https://ui.perfetto.dev (one process per arm, threads
per attempt with extra threads for overlapping calls so slices nest, turns, tokens and context as counter tracks;
every attempt starts at 0).

## Panel 3: Assessments (P3)

Data: `assessments.json`. Matrix of behavior category × arm. Each cell counts judge
assessments (one per attempt × behavior dimension, never cited units): a stacked bar in outcome order (constructive =
diverging blue, mixed = neutral gray with outline, adverse = diverging red, context-dependent = hatch, abstained = empty
outline) with the counts printed, then "n judgments · k attempts in arm". Cohort selector (Grok: primary,
deepseek-matched-timeout, all attempts) and task selector (Opus). Each cell is tagged **EBO certified** when its counts
equal the EBO Atlas report tally for that cohort and arm (report groups harness × model), **differs from EBO** when not,
and **exploratory** when the study has no report. Clicking a cell lists its judgments; clicking a judgment opens the
evidence drawer.

## Panel 4: Claims (P3)

Data: `claims.json`. Each claim shows its text, source section,
every number with its stated and recomputed value, kind (certified = EBO report tally, judge = count over the supporting
assertions, lab = unit table or audit) and expression, the supporting judgments (→ drawer), and a caveat. The header
says whether validation passed (every number recomputes and every cited native line re-hashes against the corpus).

## Evidence drawer (P3)

A right-side drawer with Back/Close (Esc). Views:

- **Assessment**: outcome, dimension, confidence, evaluator, rubric, review status (all unreviewed model proposals),
  cohorts, the judge's rationale and alternative explanation, and each citation: linked unit (step, unit #; "≈ linked by
  time/order" when the cited record is not one of the unit's own events) and the native line (path, line, SHA-256).
- **Record**: the native lines of one unit (call, result, message…) from `native/<attempt>.json`, pretty-printed when
  complete, head + tail when long; which judgments cite it; buttons to show it in the swimlanes or cloud and to open the
  attempt audit. Opened by clicking any swimlane mark.
- **Audit**: attempt identity (full id, arm, task, trial, cohorts, terminal state, steps), judgments, verdicts comparing
  the final message's check claims with the captured checks, a table of the last run / last passing run / runs / source
  changes after the last run for typecheck, lint, test and build, all checks and source changes (each opens its
  record), the full final message with claim lines highlighted, and failure chains with "compare failed vs next" (the
  last failed call and the next call of the same tool side by side, arguments and results). Opened by "Audit" in a lane
  header.

**Totals** (button next to Align): for the chosen task, all arms and attempts (arm filter and cloud selection do not
apply): totals by action category and by native tool name (total · mean per attempt · range), failures by tool and error
(click a count for those chains), recording grain (native records → events → units → tool calls, usage coverage), and the share of each
category in the N actions after each compaction or failed tool call vs elsewhere in the same attempts (per arm and
attempt, difference in percentage points on the diverging pair; click a row to highlight its window tool calls in the
cloud). Module `src/totals.ts`. Action categories since units v0.3: shell commands that write source files count as
edit / write; a command running several checks counts as its first check (`check_kinds` holds all).

Swimlane changes in P3: the lane header shows the attempt id, cohort and token-usage source ("no usage recorded" is not
zero) and an Audit button; the legend states what duration counts; Steps = actions (tool calls + compactions), the same
numbering as the audit, diff and tooltips; marks have ≥ 4 px hit targets; judge citations linked by P3 (including Pi)
are marked ▾ and the tooltip names the citing judgments; changing Task keeps the Arm when the new task has it; tooltips
clear on every redraw. Clusters × arm: attempt and unit denominators follow the cloud selection and the family tab. Cloud:
the Features list is off so the per-column count charts (now including `harness_id`, `trial_id`, `cited_assessments`)
sit at the top of the sidebar.

## Panel 5: Figures

Data: `views.json`. Each view is an EBO envelope around a Mosaic JSON spec: rendered with `parseSpec` + `astToDOM` on the
shared coordinator (data entries are SQL over `units` and the `assessments` table the viewer builds from
`assessments.json`), colors given as DESIGN.md token references (`token` scheme, then the token name), and a receipt:
the view's `query` is recomputed in DuckDB-WASM and its canonical rows hashed and compared with the build ("✓ numbers
recomputed here match the build"). **Save SVG** (`exportFigure`) downloads a figure as standalone SVG (plot + legend
redrawn). `#view=<id>` focuses a figure.

## Tokens

`src/tokens.css` is generated from `design/DESIGN.md` by `npm run tokens --workspace viewer` (pinned
`@google/design.md@0.4.0`, lint must pass); do not edit it. `src/style.css` holds component styles only and uses the tokens.
