# Design Report

## 1. Architecture

TypeScript/Node, Playwright for browser automation, Express for the mock target, Zod for the
artifact contract. Single process, synchronous call/response — no queues, no services. At this
scale (one target app, one operator) that infrastructure would be pure overhead; the brief
explicitly discourages building it prematurely.

**LLM provider**: the discovery loop talks to models through a small provider interface
(`src/agent/llm/types.ts`), not directly to any one SDK — `discover.ts` only ever calls
`provider.step(system, messages, tools)`. Two adapters exist: `AnthropicProvider` (Claude, via the
Anthropic SDK) and `OllamaProvider` (any open-weight tool-calling model served locally by Ollama,
via its native `/api/chat` endpoint, no SDK dependency, no API key, no network egress). The demo
evidence in `/evidence` was produced with `OllamaProvider` running `llama3.1:8b` entirely
on-device — the brief is explicit that provider/model is an implementation decision ("your call"),
and this keeps the required real run reproducible by anyone with `ollama pull llama3.1:8b` and no
account anywhere. `createProvider()` (`src/agent/llm/index.ts`) picks Anthropic when
`ANTHROPIC_API_KEY` is set, Ollama otherwise, or honors an explicit `--provider`/`LLM_PROVIDER`
override. One real behavioral difference the abstraction had to absorb: Anthropic's
`tool_choice:"any"` guarantees a tool call every turn; Ollama's local models have no equivalent
hard guarantee and occasionally reply with plain text instead, so `discover.ts` nudges and retries
(`nextToolCall`, bounded at 3 attempts) before treating a turn as a failed step — folded into the
same consecutive-failure/escalation path a failed click or fill already goes through.

The system has five layers, each depending only on the one below it:

```
CLI (src/cli.ts)
  ├─ discover  → src/agent      (LLM observe/decide/act loop)
  ├─ replay    → src/replay     (deterministic execution, no LLM)
  └─ catalog   → src/catalog    (lists/exposes recorded artifacts)
       both agent and replay drive:
         src/surface  (Surface interface: observe/click/fill/.../resolveElementToLocator)
           └─ src/surface/browserSurface.ts (Playwright implementation)
       both are constrained by:
         src/safety   (allowlist policy, redaction)
       both can raise:
         src/escalation (file-backed request + a small operator console)
  all typed by:
    src/schema (CapabilityArtifact, Observation, ReplayResult, EscalationRequest — Zod)
```

The load-bearing decision is the **`Surface` interface** (`src/surface/types.ts`): discovery,
replay, and artifact compilation only ever call `observe()`/`click()`/`fill()`/etc. — never
Playwright directly. `BrowserSurface` is the only implementation today, but nothing above that
seam knows it's a browser. That's the seam the heterogeneity story in §4 depends on.

Discovery is a straight observe → decide → act loop: snapshot the page into a structured
`Observation`, hand it to Claude with a fixed tool vocabulary (`click`, `fill`, `select`,
`press_key`, `extract`, `navigate`, `finish_success`, `finish_stuck`), execute exactly one tool
call, repeat. Every executed step is recorded with its resolved locator and the page text/URL
before and after — that trace is what `compileArtifact` turns into an artifact once
`finish_success` is called. Replay walks the artifact's step list directly against a fresh
`Surface`, so the artifact schema *is* the interface between the two — it's the return type of one
system and the input type of the other.

## 2. Artifact schema

`src/schema/artifact.ts`. A capability is: identity/versioning, a `target` (app id + entry URL),
typed `inputs`/`outputs`, an ordered list of `steps`, and a top-level `successCheckpoint`. Each
step is `{ action, description, locator?, value?, checkpoint?, risky }`.

Two decisions carry most of the weight:

- **Locators are a primary strategy plus an ordered fallback list**, each one of
  `role+name` / `label` / `text` / `css` / `testid` (`src/schema/locator.ts`). Discovery always
  records role+accessible-name as primary when the element has one (that's the strategy most
  likely to survive across sessions and, per §4, across tenants running the same vendor app), then
  `id`-based CSS, then a text match, then a structural CSS path as the last resort. Replay tries
  each in order and uses the first that resolves — this is the whole "accommodate the errors that
  legitimately occur" story applied to *finding things*, not just to runtime outcomes.
- **Step values are literal-or-param, never just a string** (`ValueRef`, a discriminated union).
  At compile time, any literal that exactly matches a value the caller declared as a named
  parameter (`--param memberId=10234`) becomes `{kind:"param", name:"memberId"}`; everything else
  stays a literal. This is a deliberate, boring choice over trying to have the model *infer* what's
  a parameter — that would be guessing at a much harder problem for very little gain here, and
  wrong guesses are exactly the kind of thing that silently breaks replay months later.

Checkpoints are derived the same way, not hand-authored: after each step, `compileArtifact` diffs
the page text before/after and keeps a newly-appeared line as `textContains` (falling back to a
URL-change check, then to nothing). "The confirmation page showed the words 'Review & Confirm New
Sub-Account'" is *evidence the action worked*, in the terms of the spec's own definition of a
checkpoint — not an assumption. Literal values that match a declared param are tokenized to
`{{memberId}}` inside checkpoints and inside the artifact's `target.entryUrl`, so a capability
recorded for member 10234 replays correctly for member 55555 (see `src/util/template.ts`).

Picking *which* new line matters more than it first looks. The real discovery run initially chose
the longest new line, which for the mock app's sub-accounts table row
(`"Savings\tSV-10234-1\t$4231.09"`) contains both the member ID (tokenized, since it's a declared
param) *and* that member's dollar balance (not a declared param, so left as a literal from this one
run) — a checkpoint that only ever matches member 10234's own balance, failing replay for every
other member even though the page was correct. Caught by replaying against a second member
(`tests/replay.integration.test.ts`, and the real evidence in `/evidence` includes both). Fixed by
ranking candidate lines by how many digits survive tokenization (a proxy for "still contains
per-record data") and preferring the shortest zero-digit candidate — a heading like "Member Detail"
over a data row, without any app-specific hardcoding.

The schema also refuses to compile in two cases where the artifact would otherwise make a promise
replay can't keep: if a step's source element was flagged `sensitive` (password field, SSN-shaped
name, etc.) and its value wasn't declared as an input param, `compileArtifact` throws rather than
silently writing a secret into the artifact; and a declared output only survives into the
artifact's `outputs` if some step actually has a matching `extractTo` — also found for real: the
open-weight model once called `finish_success` claiming an `accountNumber` output without ever
calling `extract` for it (it fabricated `"[REDACTED]"` instead). Without this check the artifact
would have advertised a return value replay could never produce.

`npm run schema:export` dumps every schema to JSON Schema under `artifacts/schema/` for review
without reading TypeScript.

## 3. Determinism & error handling

Replay never calls an LLM — it's Zod-validated data walked by a fixed interpreter
(`src/replay/replay.ts`). Determinism comes from three things: the locator fallback chain (§2),
checkpoints asserted after every step instead of assuming an action worked, and one bounded,
non-idempotent-aware retry for transient failures (below).

The taxonomy is a discriminated union (`src/schema/result.ts`) with four branches:

- **`success`** — every checkpoint passed; declared outputs are returned.
- **`business_outcome`** — a known, legitimate result the caller needs (not-found,
  permission-denied, session-expired, a validation error). These are matched against a small
  catalog keyed by *target app id*, not by capability (`src/replay/business-outcomes.json`) —
  "member not found" can be hit by any capability against this app, so it's a property of the app,
  not of any one artifact. The check runs after every step, before checkpoint verification, so a
  business page that happens to also fail a checkpoint is correctly classified as an outcome, not
  a bug.
- **`failure`** — a tagged `errorClass` (`element_not_found`, `checkpoint_failed`,
  `unexpected_dialog`, `session_timeout`, `transient_load_failure`, `policy_blocked`, `unknown`)
  plus `expected`/`observed`/`stepId` for debugging.
- **`escalated`** — a human intervened; the result carries their notes (§5).

Transient handling: if a step's resulting HTTP response is ≥500 and the step isn't risky, replay
waits 500ms and **reloads the page the action landed on** (not the action itself). I initially
retried by re-running the action, which for a form submission resubmitted a now-empty form on
retry — caught by the integration test (`tests/replay.integration.test.ts`, member `77777`
against a mock app that fails the first hit and succeeds after). Risky steps are deliberately
never auto-retried, since retrying a POST that already may have partially applied is not safe to
do unattended.

Native dialogs are auto-dismissed defensively (`BrowserSurface`'s `page.on("dialog")` handler) so
an unanticipated `confirm()`/`alert()` can't hard-hang a run; the mock app doesn't currently
trigger one, so this path is implemented but not exercised in the demo evidence — a documented gap,
not an oversight.

Secondary UI drift: out of scope by the brief's own framing (these are stable enterprise UIs), and
the fallback locator chain is the mitigation that exists — a `role+name` match survives most
non-structural changes; if even the CSS-path fallback fails, that's correctly reported as
`element_not_found`, not silently swallowed.

## 4. Heterogeneity & multi-tenant

**Surface abstraction.** Everything above `Surface` (`src/surface/types.ts`) only knows about
`observe()`/`click()`/`fill()`/`resolveElementToLocator()` and a `LocatorDescriptor`. A legacy
frameset/table app is still just a `Surface` — a fussier `observe()` (querying inside
`<frame>`/`<iframe>` documents) and a locator strategy mix that leans on `text`/`css` more than
`role`, since frameset-era markup often has poor implicit semantics. A native desktop app would
implement the same interface against UIAutomation/AXAPI instead of a DOM: `role`+`name` carry over
almost unchanged (desktop accessibility trees use the same concepts as ARIA), `css` would become a
control-index path down the native widget tree. Nothing in `src/agent`, `src/replay`, or the
artifact schema would need to change — that's the point of the seam.

**Multi-tenant reuse.** Two things already point at this without building it: locators prefer
`role`+accessible-name specifically *because* that's what's most likely to hold across tenants
running the same vendor product with different branding/copy around it, and the business-outcome
catalog is keyed by `appId`, not by capability, so a shared vendor app's "not found"/"permission
denied" pages are described once and reused by every capability recorded against it. The credible
next step (not built, per the brief's explicit "design, not necessarily build"): version an
artifact as `{appId, vendorVersion, tenantOverrides?}`; replay resolves a tenant's config to a base
artifact plus a small override list (branding text substitutions, a locator override for a
tenant-customized field) rather than a full re-record. Drift detection would be a lightweight
replay-time signal: track how often a step falls through to its fallback locators (already visible
per-run in evidence logs) — a rising fallback rate for one tenant is the leading indicator that its
app version has diverged and the artifact needs a tenant-specific override, before it hard-fails.

## 5. Escalation & handoff

Stuck detection has three triggers, mapped to `EscalationReason`
(`src/schema/escalation.ts`): the agent calling `finish_stuck` during discovery, three consecutive
failed actions, or reaching `maxSteps` — all in `src/agent/discover.ts`; and, in replay, a risky
step blocked without authorization, or (opt-in via `--escalate-on-hard-failure`) any hard failure.

The control-transfer model: `BrowserSurface` launches Chromium **non-headless** by default. When
escalation fires, the automation process does not close or hand off that browser — it just stops
sending it commands and blocks, polling a JSON escalation record on disk
(`src/escalation/escalate.ts`) for a resolution. The human's "control" of the live session is
simply switching to that already-open OS window and clicking into it directly — it is the actual
session (same cookies, same page, same everything), not a proxy or a fresh tab. `npm run operator`
(`src/escalation/operator/server.ts`) is a separate small Express app that reads/writes those same
JSON records: it shows the goal, the stuck step, why it stopped, and a screenshot, and a Resume
form that writes `status: "resolved"` plus the operator's free-text notes back to the file. The
paused process picks that up on its next poll, re-observes the page (which may have changed
underneath it), and either continues the discovery loop from the new state or — for a
replay-triggered escalation — reports `status: "escalated"` with the operator's notes and stops
(resuming an arbitrary replay step deterministically after manual intervention is not attempted;
see §7).

Two processes writing to one file is safe here specifically because they never write concurrently:
the automation process writes the record once at creation and only reads afterward; the operator
process writes exactly once, at resolution.

## 6. Safety

`src/safety/policy.ts` + `src/safety/allowlist.json`. Every navigation and every action, in both
discovery and replay, passes through `checkNavigation` (origin + route regex allowlist) and
`checkActionType` (action-type allowlist) before it's executed — enforced at the orchestration
layer (agent loop / replay loop), not inside `Surface`, so the same check applies uniformly
regardless of which surface implementation is underneath.

Risky/irreversible actions are classified at *discovery* time by a name-keyword heuristic against
the element being activated ("confirm", "submit", "delete", "withdraw", ...) and marked `risky:
true` on the artifact step. At *replay* time the posture is **block by default**: a risky step
requires the caller to pass `allowRisky: true` explicitly. I chose block-then-require-caller-
authorization over "pause and ask inline" because replay is the *production, no-human-present*
path (per the spec's own framing) — there's no one to ask inline, and false-inline-confirmation
would just be a rubber stamp. Authorization has to come from whoever is calling replay (the
product, presumably because a human already approved the action upstream), or the caller can opt
into `--escalate-on-risky` to route it to a human explicitly instead of just failing.

Redaction (`src/safety/redact.ts`) runs unconditionally in `RunLogger`, on every log line, not as
an opt-in: pattern-based scrubbing for SSNs/emails/bearer-tokens/credit-card-shaped strings, plus
full masking of any field whose *name* looks sensitive regardless of its value. The same
sensitive-field detection blocks a literal from ever reaching the artifact at compile time (§2).

Limits: the allowlist is a static file, not per-tenant yet (ties into §4's not-yet-built tenant
config); the risky-keyword heuristic is a simple substring match, not a learned classifier, so a
consequential action with an unexpected label could slip through unmarked — the allowlist's
route/action-type restriction is the backstop for that case, not the risky flag alone.

## 7. Cuts

- **Resuming a replay after a human intervenes.** An escalated replay reports the operator's notes
  and stops rather than trying to re-enter the step sequence from an unknown post-intervention
  state. Discovery *does* resume (it just re-observes and continues the LLM loop), because an LLM
  in the loop can adapt to whatever state the human left it in; deterministic replay can't safely
  guess. Next: a narrow "resume from step N" that re-verifies the checkpoint of the step the human
  said they completed, then continues normally.
- **Live pixel co-browsing in the operator console.** The console is a context+signal panel, not a
  screen-share; the real handoff is the actual browser window (§5). Next: CDP screencast into the
  console itself, needed once there's more than one human/machine per box.
- **Unexpected-dialog path is implemented but undemonstrated** — the mock app never opens a native
  dialog, so `page.on("dialog")` auto-dismissal is real code, not real evidence.
- **Multi-tenant config and drift detection are designed (§4), not built** — no tenant override
  file format, no fallback-rate dashboard, per the brief's explicit steer against building scaling
  infrastructure prematurely.
- **`role`-based accessible-name computation is a hand-rolled approximation** of the real
  accessibility algorithm (`src/surface/domSnapshot.ts`), not the browser's actual accname
  computation — good enough for this target and close enough to what Playwright's own `getByRole`
  computes to work reliably, but not a full spec implementation.
- Stretch goal taken: **agent-facing capability interface** — `src/catalog/catalog.ts` exposes
  every recorded artifact as an Anthropic tool definition generated straight from its typed
  `inputs`/`outputs`, ready for a calling agent to discover and invoke by name.
