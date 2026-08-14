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
         src/surface/types.ts  (role interfaces: Perception / Actions / Signals / Session)
           └─ browserSurface.ts + locatorResolver.ts (the Playwright implementation,
              the only code in the repo that imports Playwright)
       both are constrained by:
         src/safety   (allowlist policy, redaction)
       both can raise:
         src/escalation (file-backed request + a small operator console)
  all typed by:
    src/schema (CapabilityArtifact, Observation, ReplayResult, EscalationRequest — Zod)
```

The load-bearing decision is the **`Surface` seam** (`src/surface/types.ts`): discovery, replay, and
artifact compilation only ever call `observe()`/`click()`/`fill()`/etc. — never Playwright directly.
It is split into role interfaces (`SurfacePerception`, `SurfaceActions`, `SurfaceSignals`,
`SurfaceSession`) so each consumer declares the narrowest capability it needs — `verifyCheckpoint`
reads and waits, and has no access to `close()`.

Worth being precise about how that is enforced, because for a while it wasn't. The interface
existed and the write-up claimed the engine was surface-agnostic, but every consumer was *typed
against the concrete `BrowserSurface`* — the abstraction was documentation, not a seam, and a
desktop implementation would not in fact have dropped in. Consumers now depend on the interfaces,
`replay()` takes an injectable `createSurface` (defaulting to the browser), and
`tests/surfaceSeam.test.ts` drives the real replay engine against an in-memory `Surface` with no
DOM, no Playwright, and no network. The claim is now checkable rather than asserted, and it stops
compiling if someone reintroduces a concrete dependency above the seam.

`BrowserSurface` is the only production implementation today, but nothing above that
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
`{{memberId}}` inside checkpoints, inside the artifact's `target.entryUrl`, and inside any recorded
`navigate` step's URL, so a capability recorded for member 10234 replays correctly for member 55555
(see `src/util/template.ts`).

URLs are tokenized *structurally* (`tokenizeUrl`), not by the same substring replace used for
checkpoint text: only whole path segments and whole query values are matched, and the origin is
never rewritten. A URL is positional, so a blind substring replace corrupts it — with
`deposit="1"`, `/members/20001/new-subaccount` becomes `/members/2000{{deposit}}/new-subaccount`,
and any parameter whose value happens to be `4000` would eat the port out of
`http://localhost:4000/`. Whole-segment matching makes that class of false positive impossible: a
segment either *is* the parameter's value or it isn't.

This was a real bug, and the worst one in the project: `entryUrl` was originally passed through
compilation raw, so the discovery-time member was frozen into the artifact and **every replay
silently ignored `memberId`** — `open-subaccount` replayed with `memberId=10567` opened the form
for member 20001 and would have executed the irreversible "Confirm & Open Account" step against the
wrong member. A declared parameter not being honored on an irreversible action is exactly the
failure mode this system exists to prevent, and it produced no error at any layer: the allowlist
passed (same origin/route), the risky-step gate passed, and the checkpoint passed, because the page
it landed on was perfectly valid — just for the wrong member. Recorded `navigate` steps had the
identical defect, since a full URL is never *equal* to a parameter's value and so never matched the
exact-match `ValueRef` path either.

It survived because every artifact in `tests/replay.integration.test.ts` was hand-authored with
`{{memberId}}` already written in, which quietly assumed the very behavior that was missing. The
fix therefore includes `tests/replay.integration.test.ts`'s "replay of a compiled artifact honors
its declared parameters" case, which runs a real `compileArtifact` output against a *different*
member than it was recorded on and asserts on that member's data — the shape of test that would
have caught it. Both regression tests were confirmed to fail against the pre-fix code.

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

**Versioning is behaviour, not just a field.** `version` was previously always `1` and re-recording
a capability overwrote `artifacts/<name>.json` in place, which meant the previous version was simply
gone — "versioned and reviewable" described the shape of the data rather than anything the system
did. `resolveVersion` (`src/agent/versioning.ts`) now compares a **structural fingerprint** of the
new recording against what is on disk. The fingerprint deliberately excludes `createdAt` and the
generated step ids, which differ on every run: a capability's identity is its behaviour, not the
run that produced it. Identical behaviour leaves the file untouched (no spurious diff from
re-recording); changed behaviour bumps the version and archives the prior file to
`artifacts/history/<name>.v<N>.json`. `artifacts/<name>.json` stays the current-version pointer, so
the catalog and `replay --capability` are unaffected. The real discovery run in `/evidence`
exercises the identical-behaviour path (`disposition: "unchanged"`), which is the harder one to get
right given ids and timestamps change every time; the bump-and-archive path is covered by
`tests/versioning.test.ts`.

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
  `unexpected_dialog`, `transient_load_failure`, `policy_blocked`, `unknown`) plus
  `expected`/`observed`/`stepId` for debugging. Every one of these has a producer; an enum member
  nothing can emit is a claim the system does not honour. `session_timeout` used to sit here *and*
  in the business-outcome catalog — the same condition with two homes, which is precisely the
  business-outcome/failure conflation the brief names as the most common design mistake. It is a
  legitimate answer the caller must handle, so it lives only in the catalog now.
- **`escalated`** — a human intervened; the result carries their notes (§5).

Transient handling: if a step's resulting HTTP response is ≥500 and the step isn't risky, replay
waits 500ms and **reloads the page the action landed on** (not the action itself). I initially
retried by re-running the action, which for a form submission resubmitted a now-empty form on
retry — caught by the integration test (`tests/replay.integration.test.ts`, member `77777`
against a mock app that fails the first hit and succeeds after). Risky steps are deliberately
never auto-retried, since retrying a POST that already may have partially applied is not safe to
do unattended.

Native dialogs are auto-dismissed (`BrowserSurface`'s `page.on("dialog")` handler) so an
unanticipated `confirm()`/`alert()` can't hard-hang a run — but dismissing is not the same as
handling. The dialog is now recorded and drained by the caller, and replay reports
`unexpected_dialog`. Silently dismissing left the page underneath looking perfectly ordinary, so a
flow that had diverged from its recording would carry on acting on a guess. The mock app exposes an
unlinked `/members/:id/archive` page that raises a `confirm()` purely to exercise this path in
tests; it is unlinked so a stray control never lands in front of the discovery agent.

Retry safety also depends on the response accessor being *read-and-clear*
(`Surface.takeNavigation()`). A sticky "last response status" let a step that never navigated (a
fill, a select) inherit an earlier 5xx and trigger the reload above mid-form, discarding everything
typed so far.

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

One tension the network-level guard creates deserves naming, because it bites the flagship scenario.
The guard constrains the human too (§6), and the remedy for a session-timeout escalation is the
app's own "Log In Again" button — which pointed at `/login`, a route the allowlist did not cover. The
human was locked out of fixing the very thing they were called in for. `/login` is now allowlisted:
re-login is part of the target app's recovery flow, and excluding it was an oversight rather than a
security decision. That patches this app; the general answer, not built here, is an **operator-scoped
relaxation** — while an escalation is pending, widen the allowlist to a set scoped to that operator
and record every navigation made under it into the escalation record, so the widening is bounded,
attributable, and auditable rather than a standing hole.

Two processes writing to one file is safe here specifically because they never write concurrently:
the automation process writes the record once at creation and only reads afterward; the operator
process writes exactly once, at resolution.

## 6. Safety

`src/safety/policy.ts` + `src/safety/allowlist.json`. Action types are checked at the orchestration
layer (`checkActionType`, agent loop / replay loop). **Navigation is enforced one layer lower, at
the browser context**, via a `NavigationGuard` injected into the `Surface`
(`src/surface/browserSurface.ts`): a `context.route` interceptor evaluates every document
navigation against the origin + route allowlist and aborts the ones that fail.

That split is the correction of a real bug, and the reasoning matters more than the fix. Both
checks originally lived in the orchestration layer, which sounds uniform but silently is not:
orchestration only sees the navigations *it initiates*. `checkNavigation` therefore ran on the
entry URL and on discovery's `navigate` action — and nowhere else. Two holes followed. A `navigate`
step in a replayed artifact went straight to `surface.navigate()` unchecked, so a tampered artifact
(they are plain editable JSON) could send the session anywhere. And **click-driven navigation was
never checked in either mode** — a link leaving the allowlisted origin, a form submit, or a JS
redirect bypassed the guardrail entirely. That was not hypothetical: the demo app's session-expired
page has a "Log In Again" button targeting `/login`, which matches no allowlisted route pattern.

Enforcing at the network layer makes the guarantee independent of *how* navigation was triggered,
which is the only version of it that actually holds. Two details this forces:

- A blocked click throws nothing — the navigation simply never happens and the page sits still — so
  `Surface.takePolicyViolation()` exposes a read-and-clear record that both loops drain after every
  action. In replay this is checked **before** business-outcome matching, deliberately: an aborted
  click leaves the page where it was, so the `/login` case would otherwise be reported as the
  `session_timeout` business outcome and the breach would never surface. A refused navigation is
  never a business result.
- `Surface` takes the guard as an injected function rather than importing `src/safety`, so the seam
  in §4 stays surface-agnostic — a desktop `Surface` would enforce the same contract against its own
  navigation primitives. The parameter is required, not optional: a default-allow would let any
  future caller silently reopen exactly this hole.

Two deliberate scope choices. The guard lives on the context, so it **also constrains a human** who
takes over the live session during an escalation handoff — the allowlist is a property of the
automation session, not of the agent alone. And only *document* navigations are gated; subresources
continue untouched, because legacy vendor apps routinely load assets from another host and blocking
those would break pages for reasons that have nothing to do with navigation.

Steps are classified at *discovery* time by `classifyEffect` (`src/safety/policy.ts`) into
`read`, `state_changing`, or `irreversible`. This took two attempts, and the wrong turn is worth
recording because it is a tempting one.

The original classifier read only the activated element's accessible name, which was bypassable:
pressing Enter in a form field submits that form, but the name in hand is the *input's* ("Initial
Deposit"), never the submit control's — and `press_key` may carry no element reference at all. An
irreversible submit therefore compiled as harmless and replayed with no authorization. I concluded
from that "labels are unreliable" and made every non-GET request risky. **That over-corrected, and
in exactly this environment.** Legacy server-rendered apps POST for nearly everything, including
reversible intermediate steps: "Continue → review screen" is a POST that commits nothing. Gating all
of them means a caller passes `--allow-risky` on almost every step, which is the rubber-stamp
failure this section argues against two paragraphs down. A gate that is always on is the same as no
gate.

The real defect was narrower: the *wrong label* was being inspected. `formSubmitName`
(`src/surface/domSnapshot.ts`) resolves the submit control of the element's enclosing form — and for
a keypress with no element, `activeFormSubmitName()` resolves it from whatever holds focus — so the
keyword check finally runs against the control that describes what the step commits. The HTTP method
then supplies a weaker second tier: "this changed state", recorded for review without necessarily
gating. Uncertainty still resolves toward safety — a state change with no identifiable control at
all is treated as irreversible.

The artifact records the **effect**; whether an effect requires authorization is decided at replay
by `checkStepAuthorization`, because that is a property of the institution rather than of the
recording. `irreversible` always requires `allowRisky`. `state_changing` does not, unless the
deployment sets `gateStateChanging` in `allowlist.json` — the same recording then runs under a
strict or a permissive institution without being re-recorded, which is the separation that already
keeps business outcomes at app level rather than per-capability.

For an irreversible step the posture is **block by default**. I chose block-then-require-caller-
authorization over "pause and ask inline" because replay is the *production, no-human-present*
path (per the spec's own framing) — there's no one to ask inline, and false-inline-confirmation
would just be a rubber stamp. Authorization has to come from whoever is calling replay (the
product, presumably because a human already approved the action upstream), or the caller can opt
into `--escalate-on-risky` to route it to a human explicitly instead of just failing.

Redaction (`src/safety/redact.ts`) runs unconditionally in `RunLogger`, on every log line, not as
an opt-in: pattern-based scrubbing for SSNs/emails/bearer-tokens/card numbers, plus full masking of
any field whose *name* looks sensitive regardless of its value. The same sensitive-field detection
blocks a literal from ever reaching the artifact at compile time, and marks the corresponding input
parameter `sensitive` (§2).

Card detection **validates** rather than pattern-matching alone: a digit run must be 13–19 digits,
pass the Luhn check, and start with a major-network IIN digit (3–6). The pattern alone matched any
13-digit run, which meant every run id — they embed `Date.now()` — was redacted, and the evidence
log corrupted its own `evidenceDir` pointer in 13 committed files. Worth noting what the fix
deliberately avoids: tightening to separator-grouped forms (`\d{4}-\d{4}-…`) would have removed the
false positives but stopped matching unseparated `4111111111111111`. For a redactor guarding
regulated data, a false negative is a leak while a false positive is only noise, so the fix had to
reduce false positives *without* narrowing what counts as a card.

Limits, in rough order of how much they'd worry me in production:

- **Subresource egress is not gated.** Document navigations are blocked, but a page may still
  `fetch()` or load an image from an off-allowlist host. That is a data-exfiltration path, not a
  navigation one, and closing it needs a separate policy dimension (which hosts may this app talk
  to?) rather than reusing the route allowlist — gating all requests with the current list would
  break legitimate vendor apps. This is the gap I'd close first.
- **Same-document `pushState` navigation** never issues a request, so the interceptor cannot see
  it. `takePolicyViolation()` re-checks the settled URL to catch it after the fact, which detects
  but does not *prevent* — fine for a server-rendered legacy target, weaker for an SPA.
- The allowlist is a static file, not per-tenant yet (ties into §4's not-yet-built tenant config).
- The risky-keyword heuristic is a substring match, not a learned classifier, so a consequential
  action with an unexpected label could slip through unmarked — the allowlist's route/action-type
  restriction is the backstop for that case, not the risky flag alone.

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
- **Checkpoint text is still tokenized by substring replace**, not structurally like URLs (§2). The
  same partial-match hazard exists in principle — a param value of `"1"` would tokenize *inside*
  other numbers in a checkpoint string — but the blast radius is far smaller (a checkpoint that
  fails loudly, versus a URL that silently targets the wrong record), and the digit-ranking
  heuristic already steers checkpoints toward digit-free text. Next: match on word boundaries, and
  refuse to tokenize param values below a length threshold.
- **Checkpoint PII filtering is heuristic and reduces rather than eliminates the risk.** Candidate
  lines containing an extracted value are rejected and tab-separated data rows are deprioritised
  (§2), which covers the realistic cases, but a page whose only distinguishing new text is
  unextracted PII would still bake it into the artifact. A real fix needs either a second recording
  to diff against (text stable across two records is chrome; text that differs is data) or a PII
  classifier — both out of scope for one discovery run.
- **The port collision between `npm run mock` and `npm test` is reported, not removed.** Both bind
  4000 and the suite now fails with an actionable message instead of an opaque `EADDRINUSE`. It
  can't simply take an ephemeral port because the safety allowlist pins `localhost:4000`; doing this
  properly means making the allowlist origin configurable, which is the same work as the per-tenant
  config in §4 and belongs with it.
- **`role`-based accessible-name computation is a hand-rolled approximation** of the real
  accessibility algorithm (`src/surface/domSnapshot.ts`), not the browser's actual accname
  computation — good enough for this target and close enough to what Playwright's own `getByRole`
  computes to work reliably, but not a full spec implementation.
- Stretch goal taken: **agent-facing capability interface** — `src/catalog/catalog.ts` exposes
  every recorded artifact as an Anthropic tool definition generated straight from its typed
  `inputs`/`outputs`, ready for a calling agent to discover and invoke by name.
