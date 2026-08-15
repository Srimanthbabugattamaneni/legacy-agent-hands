# Design Report

## 1. Architecture

TypeScript/Node, Playwright for the browser, Express for the mock target, Zod for the artifact
contract, and an open-weight model served locally by Ollama for discovery. Single process,
synchronous — no queues or services. At one target app and one operator, that infrastructure would
be overhead, and the brief warns against building it prematurely.

```
CLI ─┬─ discover → src/agent    (LLM observe→decide→act loop)
     ├─ replay   → src/replay   (deterministic execution, no LLM)
     └─ catalog  → src/catalog  (recorded capabilities, as callable tools)
          both drive  → src/surface   (role interfaces; browserSurface.ts is the only
                                       code that imports Playwright)
          both obey   → src/safety    (allowlist, effect classification, redaction)
          both raise  → src/escalation(file-backed request + operator console)
          all typed by→ src/schema    (Zod: artifact, observation, result, escalation)
```

Two seams carry the design. **`Surface`** (`src/surface/types.ts`) separates "how we perceive and
act on a surface" from "the recorded flow", split into role interfaces
(`SurfacePerception`/`Actions`/`Signals`/`Session`) so each consumer declares only what it uses.
**`LlmProvider`** (`src/agent/llm/types.ts`) does the same for the model.

Both are enforced rather than asserted, which is a correction: for several iterations the `Surface`
interface existed while every consumer was typed against the concrete `BrowserSurface`, so the
abstraction was documentation and a desktop implementation would not have dropped in.
`replay()` and `runDiscovery()` now take injectable factories, and two tests drive the real engines
against in-memory implementations — `tests/surfaceSeam.test.ts` (no DOM, no browser) and
`tests/agentLoop.test.ts` (no model). Reintroducing a concrete dependency above either seam stops
compiling.

Running the model locally is a deliberate consequence of the domain: discovery is the only place a
model is involved at all, so keeping it on-device means the system needs no API key and makes no
outbound request — which matters when the surface being driven is a bank's back office.

## 2. Artifact schema

`src/schema/artifact.ts`. A capability is identity/version, a target, typed `inputs`/`outputs`,
ordered `steps`, and a `successCheckpoint`. Three decisions carry the weight.

**Locators are a primary strategy plus ordered fallbacks** (`role+name`, `label`, `text`, `css`).
Discovery records role+accessible-name first — the strategy most likely to survive across sessions
and across tenants running the same vendor product — then `id`, then text, then a structural CSS
path as last resort. Replay uses the first that resolves.

**Values are literal-or-parameter, never bare strings.** A recorded literal matching a declared
`--param` becomes `{kind:"param"}`; everything else stays literal. URLs are tokenized
*structurally* (`tokenizeUrl`): whole path segments and query values only, never the origin. A
substring replace corrupts URLs — with `deposit=1`, `/members/20001/` becomes
`/members/2000{{deposit}}/`. This was a real bug: `entryUrl` was originally passed through raw, so
every replay silently ignored `memberId` and would have opened an account against the wrong member,
with no error at any layer because the page it landed on was perfectly valid.

**Checkpoints are derived, not authored.** After each step the compiler diffs page text and keeps a
newly-appeared line — evidence the action worked rather than an assumption. Choosing *which* line
matters: candidates are ranked by digits surviving tokenization (a proxy for per-record data),
tab-separated rows are deprioritised as data rows, and any line containing an extracted value is
rejected outright. Without that, a checkpoint pinned to one member's balance — or their name — and
failed for everyone else.

The compiler also refuses to lie. A sensitive field's value cannot be persisted as a literal; a
declared output survives only if a step actually extracts it (a model once claimed an output it had
fabricated); step descriptions are stripped of observed values, so no member name reaches a
committed file. `resolveVersion` compares a structural fingerprint (ignoring ids and timestamps,
which change every run), bumps on behavioural change, and archives the prior file — versioning is
behaviour, not just a field. `npm run schema:export` emits JSON Schema for review.

## 3. Determinism & error handling

Replay never calls a model: it is Zod-validated data walked by a fixed interpreter. Determinism
comes from the locator fallback chain, checkpoints asserted after every step, and one bounded
retry. The result contract is a discriminated union:

- **`success`** — every checkpoint passed; declared outputs returned.
- **`business_outcome`** — a legitimate result the caller must handle (not-found,
  permission-denied, session-expired, validation error), matched from a catalog keyed by *app id*
  (`src/replay/business-outcomes.json`), not per-capability: "member not found" is a property of the
  app, reachable by any capability against it.
- **`failure`** — a tagged `errorClass` (`element_not_found`, `checkpoint_failed`,
  `unexpected_dialog`, `transient_load_failure`, `policy_blocked`, `unknown`) with
  expected/observed/stepId. Every member has a producer; `session_timeout` deliberately is *not*
  here, because it is a business outcome, and listing one condition in both places is exactly the
  conflation the brief calls the most common design mistake.
- **`escalated`** — a human intervened; the result carries their notes.

Ordering is load-bearing. A refused navigation or an unexpected dialog is checked *before*
business-outcome matching: a blocked click leaves the page untouched, so the session-expired page
underneath would otherwise report `session_timeout` and the guardrail breach would vanish.

Transient handling retries by *reloading the page the action landed on*, not by re-running the
action — and only for `read` steps, since reloading a page a POST produced re-submits it. Native
dialogs are auto-dismissed so a run cannot hang, but recorded and reported: dismissing silently
leaves the page looking ordinary while the flow has diverged. Surface signals (response, dialog,
policy violation) are **read-and-clear**; a sticky "last response status" let a non-navigating step
inherit an earlier 5xx and reload mid-form, discarding everything typed.

UI drift is secondary by the brief's framing; the fallback chain is the mitigation, and exhausting
it reports `element_not_found` rather than proceeding blindly.

## 4. Heterogeneity & multi-tenant

**Surface abstraction.** Everything above `Surface` knows only `observe`/`click`/`fill`/… and a
`LocatorDescriptor`. A legacy frameset app is the same interfaces with a fussier `observe()` and a
locator mix favouring `text`/`css`. A desktop app implements them against UIAutomation/AXAPI:
`role`/`name` carry over almost unchanged because desktop accessibility trees use the same concepts,
with `css` replaced by a control-index path. The seam tests prove the engines already run against a
non-browser implementation.

**Multi-tenant reuse** (designed, not built). Two choices already point at it: locators prefer
role+accessible-name precisely because that survives tenant branding, and the business-outcome
catalog is keyed by app rather than capability, so a shared vendor product is described once. Next
is representing an artifact as `{appId, vendorVersion, tenantOverrides?}` — resolving a tenant to a
base artifact plus a small override list instead of re-recording per tenant. Drift detection comes
free from data the evidence logs already carry: a rising rate of steps falling through to fallback
locators is the leading indicator that one tenant's version has diverged, before it hard-fails.

## 5. Escalation & handoff

Stuck is detected from three triggers: the agent calling `finish_stuck`, three consecutive failed
actions, or exhausting the step budget; in replay, a blocked irreversible step
(`--escalate-on-risky`) or any hard failure (`--escalate-on-hard-failure`).

The control-transfer model is deliberately literal. The browser runs **non-headless**, so when
escalation fires the automation simply stops sending commands and blocks, polling a JSON escalation
record. The human's "control" is the already-open window — the actual session, same cookies, same
page, not a proxy. `npm run operator` is a separate Express app reading and writing those same
records: it shows the goal, stuck step, reason and screenshot, and a Resume form that writes the
operator's notes back. The waiting process picks that up, re-observes, and either continues the
discovery loop or reports `escalated` with the notes. Two processes share one file safely because
they never write concurrently.

One tension is worth naming: the navigation guard constrains the human too (§6), and the remedy for
a session-timeout escalation is the app's own "Log In Again" button — which pointed at `/login`, a
route the allowlist did not cover, locking the operator out of the very session they were called in
to rescue. `/login` is now allowlisted. The general answer, not built, is an **operator-scoped
relaxation**: while an escalation is pending, widen the allowlist to a set scoped to that operator
and record every navigation made under it into the escalation record — bounded, attributable, and
auditable rather than a standing hole.

Discovery resumes after intervention; replay does not. An LLM can adapt to whatever state a human
left behind, a fixed interpreter cannot, so replay reports and stops rather than guessing.

## 6. Safety

**Navigation is enforced at the browser context**, not at call sites: a `context.route` interceptor
evaluates every document navigation against the origin/route allowlist. That placement is a
correction. Enforcement originally lived in the orchestration layer, which only sees navigations it
initiates — so a `navigate` step in a tampered artifact (they are editable JSON) and *all*
click-driven navigation escaped the guardrail entirely. The guard is injected into `Surface` rather
than imported, keeping the seam policy-agnostic, and is a required parameter so no future caller can
silently reopen the hole. Because it lives on the context it also constrains a human during handoff:
the allowlist is a property of the session, not of the agent.

**Steps are classified by effect** — `read`, `state_changing`, `irreversible` (`classifyEffect`).
This took two attempts and the wrong turn is instructive. Classification originally read only the
activated element's name, which pressing Enter in a form field defeats: the name in hand is the
*input's* ("Initial Deposit"), never the submit control's. I concluded labels were unreliable and
made every non-GET risky — which over-corrects badly here, because legacy server-rendered apps POST
for nearly everything, including reversible steps like "Continue → review screen". Gating those
forces `--allow-risky` on almost every step, and a gate that is always on is the same as no gate.
The real defect was reading the *wrong label*: `formSubmitName` resolves the enclosing form's submit
control, so the keyword check finally runs against what the step commits. The method then supplies a
weaker second tier. Uncertainty resolves toward safety: a state change with no identifiable control
is treated as irreversible.

The artifact records the effect; whether an effect needs authorization is decided at replay
(`checkStepAuthorization`), because that is a property of the institution, not the recording.
`irreversible` always requires `allowRisky` — block-by-default rather than confirm-inline, since
production replay has no human to ask. `state_changing` does not, unless a deployment sets
`gateStateChanging`.

**Redaction** runs unconditionally in `RunLogger`, plus full masking of sensitive-looking field
names. Card detection validates rather than pattern-matches — 13–19 digits, Luhn, major-network IIN
— because the pattern alone matched any 13-digit run, including the epoch timestamp in every run id,
which corrupted the evidence log's own directory pointer. Note the direction the fix takes:
narrowing to separator-grouped forms would have removed false positives while missing unseparated
PANs, and for a redactor a false negative is a leak while a false positive is only noise.

Limits, worst first: **subresource egress is not gated** — document navigations are blocked, but a
page may still `fetch()` off-allowlist. That is an exfiltration path needing its own policy
dimension (which hosts may this app talk to), and it is the gap I would close first. Same-document
`pushState` is detected after the fact rather than prevented. The allowlist is a static file, not
per-tenant. The risky-keyword list is substring matching, not a classifier.

## 7. Cuts

- **Resuming a replay after human intervention** — reported and stopped instead (§5). Next: resume
  from step N after re-verifying that step's checkpoint.
- **Live co-browsing in the operator console** — it is a context-and-signal panel; the real handoff
  is the browser window. Next: CDP screencast, needed once there is more than one operator per box.
- **Multi-tenant config and drift detection** — designed in §4, not built, per the brief's explicit
  steer against premature scaling infrastructure.
- **Checkpoint PII filtering is heuristic**, and reduces rather than eliminates the risk. A real fix
  needs a second recording to diff against (text stable across two records is chrome; text that
  differs is data) or a PII classifier.
- **Checkpoint text still uses substring tokenization**, unlike URLs — smaller blast radius, since a
  checkpoint fails loudly where a URL silently targets the wrong record. `npm test` and
  `npm run mock` also both bind port 4000; the suite now fails with an actionable message, and
  fixing it properly means making the allowlist origin configurable, which belongs with the
  per-tenant config above.
- **One provider ships.** `LlmProvider` is tested against a scripted implementation, but a hosted
  adapter is not included — it would be a new file, not a change to the loop.
- Stretch goal taken: **agent-facing capability interface** — `src/catalog/catalog.ts` exposes every
  artifact as a typed, callable tool definition generated from its declared inputs/outputs.
