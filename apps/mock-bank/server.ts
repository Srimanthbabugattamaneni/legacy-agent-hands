import express from "express";

/**
 * A deliberately legacy-feeling back-office bank app: table-based layout,
 * no test IDs, no explicit ARIA roles or data attributes for automation.
 * Interactive elements only carry the *implicit* roles/names the browser
 * derives from native HTML semantics (input/button/a/select/label-for) —
 * which is what a real 2005-era internal banking tool looks like, and
 * exactly the case the surface layer has to handle without a clean DOM.
 */

type Member = {
  id: string;
  name: string;
  status: "active";
  savings: number;
  checking: number;
  subAccounts: { type: string; accountNumber: string; balance: number }[];
};

const members = new Map<string, Member>([
  ["10234", { id: "10234", name: "Jordan Alvarez", status: "active", savings: 4231.09, checking: 812.44, subAccounts: [{ type: "Savings", accountNumber: "SV-10234-1", balance: 4231.09 }] }],
  ["10567", { id: "10567", name: "Priya Natarajan", status: "active", savings: 18902.5, checking: 3004.12, subAccounts: [{ type: "Savings", accountNumber: "SV-10567-1", balance: 18902.5 }, { type: "Checking", accountNumber: "CK-10567-1", balance: 3004.12 }] }],
  ["20001", { id: "20001", name: "Sam Whitfield", status: "active", savings: 954.0, checking: 120.33, subAccounts: [{ type: "Checking", accountNumber: "CK-20001-1", balance: 120.33 }] }],
  ["77777", { id: "77777", name: "Casey Nguyen", status: "active", savings: 2200.0, checking: 500.0, subAccounts: [{ type: "Checking", accountNumber: "CK-77777-1", balance: 500.0 }] }],
]);

let subAccountCounter = 1;
const transientTriggered = new Set<string>();

function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

function layout(title: string, body: string): string {
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Mock Bank Back Office - ${title}</title></head>
<body bgcolor="#ffffff">
<table width="100%" cellpadding="4" cellspacing="0" border="0" bgcolor="#003366">
  <tr><td><font color="#ffffff" size="4"><b>MERIDIAN CORE BANKING &mdash; Back Office</b></font></td></tr>
</table>
<table width="100%" cellpadding="10" cellspacing="0" border="0">
  <tr><td>
    <a href="/">Home</a>
    ${body}
  </td></tr>
</table>
</body>
</html>`;
}

function searchForm(): string {
  return `
<h2>Member Lookup</h2>
<form method="GET" action="/members">
  <table cellpadding="3" cellspacing="0" border="0">
    <tr>
      <td><label for="q">Member ID</label></td>
      <td><input type="text" id="q" name="q" size="12"></td>
      <td><button type="submit">Search</button></td>
    </tr>
  </table>
</form>`;
}

const app = express();
app.use(express.urlencoded({ extended: false }));

app.get("/", (_req, res) => {
  res.send(layout("Home", searchForm()));
});

app.get("/members", (req, res) => {
  const q = String(req.query.q ?? "").trim();
  if (!/^\d+$/.test(q)) {
    res.send(
      layout(
        "Search",
        searchForm() + `<p><font color="#cc0000"><b>Please enter a numeric Member ID.</b></font></p>`
      )
    );
    return;
  }
  res.redirect(`/members/${q}`);
});

app.get("/members/:id", (req, res) => {
  const id = req.params.id;

  if (id === "88888") {
    res.send(
      layout(
        "Access Denied",
        searchForm() +
          `<p><font color="#cc0000"><b>Access Denied.</b></font> This member record requires elevated permissions. Contact your supervisor to request access.</p>`
      )
    );
    return;
  }

  if (id === "99999") {
    res.send(
      layout(
        "Session Expired",
        `<h2>Session Expired</h2><p>Your session has timed out for security reasons.</p>
         <form method="GET" action="/login"><button type="submit">Log In Again</button></form>`
      )
    );
    return;
  }

  if (id === "77777" && !transientTriggered.has(id)) {
    transientTriggered.add(id);
    res.status(503).send(
      layout(
        "Service Unavailable",
        searchForm() + `<p><font color="#cc0000"><b>The service is temporarily unavailable. Please try again.</b></font></p>`
      )
    );
    return;
  }

  const member = members.get(id);
  if (!member) {
    res.send(
      layout(
        "Search Results",
        searchForm() + `<p>No matching member found for &quot;${id}&quot;.</p>`
      )
    );
    return;
  }

  const rows = member.subAccounts
    .map((sa) => `<tr><td>${sa.type}</td><td>${sa.accountNumber}</td><td align="right">${money(sa.balance)}</td></tr>`)
    .join("");

  res.send(
    layout(
      `Member ${member.id}`,
      `
<h2>Member Detail</h2>
<table cellpadding="3" cellspacing="0" border="1">
  <tr><td><b>Member ID</b></td><td>${member.id}</td></tr>
  <tr><td><b>Name</b></td><td>${member.name}</td></tr>
  <tr><td><b>Status</b></td><td>${member.status}</td></tr>
  <tr><td><b>Savings Balance</b></td><td>${money(member.savings)}</td></tr>
  <tr><td><b>Checking Balance</b></td><td>${money(member.checking)}</td></tr>
</table>
<h3>Sub-Accounts</h3>
<table cellpadding="3" cellspacing="0" border="1">
  <tr><td><b>Type</b></td><td><b>Account #</b></td><td><b>Balance</b></td></tr>
  ${rows}
</table>
<p><a href="/members/${member.id}/new-subaccount"><button type="button" onclick="location.href='/members/${member.id}/new-subaccount'">Open New Sub-Account</button></a></p>
<p><a href="http://localhost:4999/partner-portal">Partner Credit Portal</a></p>
`
    )
  );
});

app.get("/members/:id/new-subaccount", (req, res) => {
  const id = req.params.id;
  const member = members.get(id);
  if (!member) {
    res.status(404).send(layout("Not Found", searchForm() + `<p>No matching member found for &quot;${id}&quot;.</p>`));
    return;
  }
  res.send(
    layout(
      "New Sub-Account",
      `
<h2>Open New Sub-Account &mdash; ${member.name} (${member.id})</h2>
<form method="POST" action="/members/${member.id}/new-subaccount">
  <table cellpadding="3" cellspacing="0" border="0">
    <tr><td><label for="acctType">Account Type</label></td>
        <td><select id="acctType" name="acctType">
              <option value="Savings">Savings</option>
              <option value="Checking">Checking</option>
              <option value="CD">Certificate of Deposit</option>
            </select></td></tr>
    <tr><td><label for="deposit">Initial Deposit</label></td>
        <td><input type="text" id="deposit" name="deposit" size="10"></td></tr>
    <tr><td colspan="2"><button type="submit">Continue</button></td></tr>
  </table>
</form>`
    )
  );
});

app.post("/members/:id/new-subaccount", (req, res) => {
  const id = req.params.id;
  const member = members.get(id);
  if (!member) {
    res.status(404).send(layout("Not Found", searchForm()));
    return;
  }
  const acctType = String(req.body.acctType ?? "Savings");
  const depositRaw = String(req.body.deposit ?? "").replace(/[$,]/g, "");
  const deposit = Number(depositRaw);

  if (!depositRaw || Number.isNaN(deposit) || deposit < 25) {
    res.send(
      layout(
        "New Sub-Account",
        `
<h2>Open New Sub-Account &mdash; ${member.name} (${member.id})</h2>
<p><font color="#cc0000"><b>Initial deposit must be at least $25.00.</b></font></p>
<form method="POST" action="/members/${member.id}/new-subaccount">
  <table cellpadding="3" cellspacing="0" border="0">
    <tr><td><label for="acctType">Account Type</label></td>
        <td><select id="acctType" name="acctType">
              <option value="Savings" ${acctType === "Savings" ? "selected" : ""}>Savings</option>
              <option value="Checking" ${acctType === "Checking" ? "selected" : ""}>Checking</option>
              <option value="CD" ${acctType === "CD" ? "selected" : ""}>Certificate of Deposit</option>
            </select></td></tr>
    <tr><td><label for="deposit">Initial Deposit</label></td>
        <td><input type="text" id="deposit" name="deposit" size="10" value="${depositRaw}"></td></tr>
    <tr><td colspan="2"><button type="submit">Continue</button></td></tr>
  </table>
</form>`
      )
    );
    return;
  }

  res.send(
    layout(
      "Review & Confirm",
      `
<h2>Review &amp; Confirm New Sub-Account</h2>
<table cellpadding="3" cellspacing="0" border="1">
  <tr><td><b>Member</b></td><td>${member.name} (${member.id})</td></tr>
  <tr><td><b>Account Type</b></td><td>${acctType}</td></tr>
  <tr><td><b>Initial Deposit</b></td><td>${money(deposit)}</td></tr>
</table>
<form method="POST" action="/members/${member.id}/new-subaccount/confirm">
  <input type="hidden" name="acctType" value="${acctType}">
  <input type="hidden" name="deposit" value="${deposit}">
  <button type="submit">Confirm &amp; Open Account</button>
</form>
<form method="GET" action="/members/${member.id}">
  <button type="submit">Cancel</button>
</form>`
    )
  );
});

app.post("/members/:id/new-subaccount/confirm", (req, res) => {
  const id = req.params.id;
  const member = members.get(id);
  if (!member) {
    res.status(404).send(layout("Not Found", searchForm()));
    return;
  }
  const acctType = String(req.body.acctType ?? "Savings");
  const deposit = Number(req.body.deposit ?? 0);

  subAccountCounter += 1;
  const accountNumber = `${acctType.slice(0, 2).toUpperCase()}-${member.id}-${subAccountCounter}`;
  member.subAccounts.push({ type: acctType, accountNumber, balance: deposit });

  res.send(
    layout(
      "Sub-Account Opened",
      `
<h2>Sub-Account Opened Successfully</h2>
<table cellpadding="3" cellspacing="0" border="1">
  <tr><td><b>Member</b></td><td>${member.name} (${member.id})</td></tr>
  <tr><td><b>New Account Number</b></td><td>${accountNumber}</td></tr>
  <tr><td><b>Account Type</b></td><td>${acctType}</td></tr>
  <tr><td><b>Initial Deposit</b></td><td>${money(deposit)}</td></tr>
</table>`
    )
  );
});

app.get("/login", (_req, res) => {
  res.send(layout("Log In", `<h2>Log In</h2><p>(stub — not implemented, out of scope)</p>`));
});

export { app };

// Only auto-start a listener when run directly (`npm run mock`) — tests
// import `app` and bind it to an ephemeral port themselves instead.
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const port = Number(process.env.MOCK_BANK_PORT ?? 4000);
  app.listen(port, () => {
    console.log(`mock-bank listening on http://localhost:${port}`);
  });
}
