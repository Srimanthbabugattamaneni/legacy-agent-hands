# legacy-agent-hands

A record-once / replay-many capability engine for legacy bank back-office apps: an LLM discovers
how to do something once by driving a real UI, that run is compiled into a typed, reviewable
**capability artifact**, and afterwards the artifact **replays deterministically** — no model in
the loop — with structured success/business-outcome/failure reporting and a real human-escalation
path when it can't safely proceed.

See [`REPORT.md`](./REPORT.md) for the design write-up (architecture, schema, error handling,
heterogeneity/multi-tenant story, escalation model, safety model, and cuts).

## 1. Setup

Requirements: Node >= 20.

```bash
npm install                 # also runs `playwright install chromium` via postinstall
cp .env.example .env        # then fill in ANTHROPIC_API_KEY, or see "no API key" below
```

An LLM is only required for `discover` (the real LLM-driven run). `replay` and `catalog` never
call an LLM and run entirely offline — that's the point of the system.

**No Anthropic API key? No account of any kind needed.** The discovery loop talks to models
through a small provider interface (`src/agent/llm/`), and the demo evidence in `/evidence` was
produced entirely with a free, open-weight model running locally via [Ollama](https://ollama.com)
— no key, no signup, no network egress:

```bash
brew install ollama          # or see https://ollama.com/download
brew services start ollama
ollama pull llama3.1:8b      # ~5GB, tool-calling capable
npm run discover -- --goal "..." --target ... --name ...   # auto-selects Ollama when no ANTHROPIC_API_KEY is set
```

`createProvider()` picks Anthropic when `ANTHROPIC_API_KEY` is set, Ollama otherwise; override
explicitly with `--provider anthropic|ollama` or `--model <name>` on the `discover` command.

### The target application

`apps/mock-bank` is a deliberately legacy-styled Express app standing in for a real core-banking
back-office screen: table-based layout, no test IDs, no ARIA attributes — only the *implicit*
roles/names the browser derives from plain HTML (`<label for>`, native `<button>`/`<input>`/`<a>`
semantics). It has a member-lookup flow and a multi-step "open a new sub-account" flow with a
review/confirmation step, plus deliberate runtime-error branches: not-found, permission-denied,
session-timeout, a one-time transient 503, and form validation. Start it with:

```bash
npm run mock       # http://localhost:4000
```

Leave this running in one terminal for everything below.

## 2. Demo path

### a. Discover a capability (real LLM run)

Read-only lookup:

```bash
npm run discover -- \
  --goal "Look up member 10234 and read their current savings and checking balance" \
  --target http://localhost:4000/ \
  --name lookup-balance \
  --description "Look up a member by ID and read their current savings and checking balances." \
  --param memberId=10234
```

Multi-step form with a confirmation screen and a final irreversible submit:

```bash
npm run discover -- \
  --goal "Set the Account Type dropdown to exactly 'Savings', enter 100 as the Initial Deposit, click Continue to reach the review screen, then click Confirm & Open Account to finish opening the Savings sub-account for this member" \
  --target http://localhost:4000/members/20001/new-subaccount \
  --name open-subaccount \
  --description "Open a new Savings sub-account for a member with a given initial deposit." \
  --param memberId=20001 --param deposit=100 --max-steps 15
```

(The second goal is spelled out step-by-step because the demo evidence in `/evidence` was produced
with a small local open-weight model — see "No Anthropic API key?" above — which follows explicit,
concrete instructions more reliably than an open-ended goal. A frontier hosted model handles the
shorter, more natural phrasing fine.)

Re-running `discover` for a name that already exists compares the new recording against the stored
one: identical behaviour leaves the artifact untouched, changed behaviour bumps `version` and
archives the previous file to `artifacts/history/<name>.v<N>.json`. `artifacts/<name>.json` is
always the current version.

By default the browser is visible (`HEADLESS=false`, matching `.env.example`) so you can watch the
agent work and, if it escalates, take over the same window. A structured run log (and a
screenshot) is written to `evidence/discover-<name>-<timestamp>/`; the compiled capability is
written to `artifacts/<name>.json`.

### b. Inspect the catalog

```bash
npm run catalog                    # list recorded capabilities
npm run catalog -- show lookup-balance
```

### c. Replay deterministically (no LLM, this is the production path)

```bash
npm run replay -- --capability lookup-balance --params '{"memberId":"10234"}'
npm run replay -- --capability lookup-balance --params '{"memberId":"55555"}'   # business outcome: not found
npm run replay -- --capability lookup-balance --params '{"memberId":"88888"}'   # business outcome: permission denied
npm run replay -- --capability lookup-balance --params '{"memberId":"99999"}'   # business outcome: session expired
npm run replay -- --capability lookup-balance --params '{"memberId":"77777"}'   # recovers from a one-time transient 503
```

Each step of `open-subaccount` records what it **does** — `read`, `state_changing`, or
`irreversible`. Only `irreversible` is gated by default, so "Continue → review screen" (a POST that
commits nothing) replays freely while "Confirm & Open Account" does not. Gating every state change
would mean passing `--allow-risky` on nearly every step of a legacy flow, which turns the gate into
a rubber stamp; an institution that wants the stricter posture sets `gateStateChanging` in
[src/safety/allowlist.json](src/safety/allowlist.json). See REPORT.md §6.

```bash
npm run replay -- --capability open-subaccount --params '{"memberId":"20001","deposit":"100"}'
# -> status: "failure", errorClass: "policy_blocked"
#    (reaches the review screen, then stops at the irreversible confirm — which is not executed)

npm run replay -- --capability open-subaccount --params '{"memberId":"20001","deposit":"100"}' --allow-risky
# -> status: "success" (explicitly authorized)

npm run replay -- --capability open-subaccount --params '{"memberId":"10567","deposit":"5"}' --allow-risky
# -> status: "business_outcome" (deposit below the $25 minimum — a legitimate result, not a crash)
```

Each replay prints a structured JSON `ReplayResult` and writes its own evidence run under
`evidence/replay-<capability>-<timestamp>/`.

The other half of the safety model — the **navigation allowlist** — is enforced at the browser
context, so it holds however navigation was triggered (a navigate step in a tampered artifact, a
click onto a link leaving the origin, a form submit, a redirect). Demonstrating it needs an
artifact deliberately pointed off-allowlist, which would be a lie sitting in the capability
catalog, so it is exercised by the test suite against the real browser and the real mock app
instead — `npm test`, the "allowlist enforcement covers navigation however it was triggered"
block in [tests/replay.integration.test.ts](tests/replay.integration.test.ts). See REPORT.md §6.

### d. Human escalation & handoff

To see a live escalation, force one on a replay's blocked risky step and add `--headed` so you
have a real browser window to take over, plus `--escalate-on-risky`:

```bash
npm run replay -- --capability open-subaccount --params '{"memberId":"20001","deposit":"100"}' \
  --headed --escalate-on-risky
```

The process pauses and prints an escalation ID. In another terminal:

```bash
npm run operator   # http://localhost:4100
```

Open the printed URL, read the context (goal, stuck step, reason, screenshot), optionally act
directly in the live (headed) browser window the automation opened — it's the same session, not a
copy — then submit **Resume**. The waiting process picks up the resolution and reports a
`status: "escalated"` result including your notes. The same mechanism fires automatically during
`discover` if the agent calls `finish_stuck` or fails the same action three times in a row.

## 3. Tests

```bash
npm test          # vitest: unit tests + real Playwright-driven replay tests against apps/mock-bank
npm run typecheck
```

The suite starts its own copy of the mock bank on port 4000, so **stop `npm run mock` before
running it** — otherwise the run fails on `EADDRINUSE` (with a message saying so). It can't just
grab a free port because the safety allowlist pins `localhost:4000`; see REPORT.md §7.

The replay tests never call an LLM (replay never does), so they're fast, deterministic, and
CI-safe. They exercise the full error taxonomy end to end: success, all four business-outcome
branches, transient-failure recovery, and both sides of the risky-step policy gate.

## 4. Project layout

```
apps/mock-bank/        the proxy target — a legacy-styled back-office app
src/schema/             zod schemas: capability artifact, observation, replay result, escalation
src/surface/            perception/action layer (Playwright + accessibility-role based locators)
src/agent/              the discovery loop (LLM tool-use) + artifact compiler
src/replay/             the deterministic replay engine + business-outcome catalog
src/safety/             allowlist policy + redaction
src/escalation/         escalation records + the mock operator console
src/catalog/            capability catalog / agent-facing tool surface
src/cli.ts              discover / replay / catalog commands
artifacts/               recorded capabilities (+ exported JSON Schema under artifacts/schema/)
evidence/                structured run logs + screenshots from real discover/replay runs
```

## 5. What's mocked, deliberately

- **Operator console UI**: minimal (list/detail/resume), not a co-browsing proxy. The real
  control-transfer is the live, non-headless Playwright browser window itself — see REPORT.md §5.
- **Multi-tenant / desktop surfaces**: not implemented, only designed for — see REPORT.md §4.

See REPORT.md §7 for the full list of cuts and what's next.
