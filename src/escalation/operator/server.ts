import express from "express";
import path from "node:path";
import { writeFileSync } from "node:fs";
import { listEscalations, readEscalation, escalationPath } from "../escalate.js";

/**
 * Mock operator console (spec 3.6 scope note: "mock the operator UI if
 * needed, but make the handoff mechanism and control-transfer model real").
 *
 * What's real: the escalation record, the paused live browser session
 * (opened non-headless by the automation process — the human clicks
 * directly into that OS window, which *is* the live session, not a copy of
 * it), and the resume signal this console writes back to disk, which the
 * paused automation process is polling for.
 *
 * What's mocked: pixel-level co-browsing inside this console itself. A real
 * operator console would proxy the live page (e.g. CDP screencast) into the
 * browser tab you're reading right now; here the human instead switches to
 * the actual browser window Playwright opened. That's a deliberate scope
 * cut — see REPORT.md — not an oversight.
 */

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use("/evidence", express.static(path.join(process.cwd(), "evidence")));

function layout(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Operator Console - ${title}</title>
<style>body{font-family:system-ui,sans-serif;max-width:820px;margin:2rem auto;padding:0 1rem;color:#111}
table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:6px 10px;text-align:left}
.pending{color:#a15c00;font-weight:bold}.resolved{color:#1a7a1a}
img{max-width:100%;border:1px solid #ccc;margin-top:.5rem}
textarea{width:100%;min-height:80px}</style></head>
<body><h1>Escalation Operator Console</h1><p><a href="/">&larr; all escalations</a></p>${body}</body></html>`;
}

app.get("/", (_req, res) => {
  const items = listEscalations();
  const rows = items
    .map(
      (e) => `<tr>
      <td><a href="/escalations/${e.id}">${e.id}</a></td>
      <td>${e.reason}</td>
      <td>${e.goalOrCapability}</td>
      <td class="${e.status}">${e.status}</td>
      <td>${e.createdAt}</td>
    </tr>`
    )
    .join("");
  res.send(
    layout(
      "All Escalations",
      `<p>The automation process for a pending item has a real, live browser window open on this
       machine — switch to it to operate the session directly. This console is the side-channel
       for context and the resume signal.</p>
      <table><tr><th>ID</th><th>Reason</th><th>Goal / Capability</th><th>Status</th><th>Created</th></tr>${rows}</table>`
    )
  );
});

app.get("/escalations/:id", (req, res) => {
  const e = readEscalation(req.params.id);
  const shot = e.screenshotPath
    ? `<img src="/evidence/${path.relative(path.join(process.cwd(), "evidence"), e.screenshotPath)}">`
    : "<p>(no screenshot captured)</p>";
  const resumeForm =
    e.status === "pending"
      ? `<h3>Resume</h3>
         <form method="POST" action="/escalations/${e.id}/resume">
           <label>What did you do in the live session (or instructions for the agent to continue)?</label>
           <textarea name="humanNotes" required></textarea>
           <p><button type="submit">Signal Resume</button></p>
         </form>`
      : `<h3>Resolved</h3><p>${e.resolvedAt}</p><p><b>Operator notes:</b> ${e.humanNotes ?? ""}</p>` +
        `<h3>Recorded activity</h3>` +
        (e.humanActions.length
          ? `<ul>${e.humanActions.map((a) => `<li>${a.at} — ${a.description}</li>`).join("")}</ul>`
          : "<p>(none recorded yet — captured when the run resumes)</p>") +
        `<p><small>Notes are the operator's own account; recorded activity is what the
          automation independently observed of the session across the handoff.</small></p>`;

  res.send(
    layout(
      e.id,
      `<h2>${e.id} &mdash; <span class="${e.status}">${e.status}</span></h2>
       <p><b>Reason:</b> ${e.reason}</p>
       <p><b>Goal / capability:</b> ${e.goalOrCapability}</p>
       <p><b>Stuck at step:</b> ${e.currentStepDescription}</p>
       <p><b>Why it stopped:</b> ${e.detail}</p>
       ${shot}
       ${resumeForm}`
    )
  );
});

app.post("/escalations/:id/resume", (req, res) => {
  const e = readEscalation(req.params.id);
  const updated = {
    ...e,
    status: "resolved" as const,
    humanNotes: String(req.body.humanNotes ?? ""),
    resolvedAt: new Date().toISOString(),
  };
  writeFileSync(escalationPath(e.id), JSON.stringify(updated, null, 2));
  res.redirect(`/escalations/${e.id}`);
});

const port = Number(process.env.OPERATOR_PORT ?? 4100);
app.listen(port, () => {
  console.log(`operator console listening on http://localhost:${port}`);
});
