import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { BrowserSurface } from "../src/surface/browserSurface.js";

/**
 * Surface-level tests against a purpose-built app rather than the mock bank:
 * these exercise browser mechanics (redirect handling, control-kind
 * extraction) that the bank app deliberately doesn't have. It runs on its own
 * port with an allow-everything guard, since the policy allowlist is not what
 * is under test here.
 */
const PORT = 4321;
const BASE = `http://localhost:${PORT}`;
const allowAll = () => ({ allowed: true, reason: "test" });

let server: Server;

beforeAll(async () => {
  const app = express();
  app.use(express.urlencoded({ extended: false }));

  // Post/redirect/get: the POST is answered with a 302 to a GET.
  app.get("/prg", (_req, res) =>
    res.send(`<form method="POST" action="/prg"><button type="submit">Submit PRG</button></form>`)
  );
  app.post("/prg", (_req, res) => res.redirect("/prg-done"));
  app.get("/prg-done", (_req, res) => res.send("<h1>Done</h1>"));

  // A plain GET form, to prove the latch doesn't invent a POST.
  app.get("/get-form", (_req, res) =>
    res.send(`<form method="GET" action="/prg-done"><button type="submit">Submit GET</button></form>`)
  );

  app.get("/controls", (_req, res) =>
    res.send(`
      <select id="acct">
        <option value="Savings">Savings</option>
        <option value="Checking" selected>Checking</option>
        <option value="CD">Certificate of Deposit</option>
      </select>
      <input id="amount" value="250">
      <p id="para">Just text</p>`)
  );

  server = app.listen(PORT);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("takeNavigation", () => {
  it("reports POST through a post/redirect/get flow", async () => {
    // Regression: the listener overwrote the recorded method on every
    // document response, so the trailing GET of a PRG flow erased the POST
    // and a state-changing step looked like a read. PRG is the dominant
    // pattern in real apps, so this was precisely the case the method signal
    // exists to catch.
    const surface = await BrowserSurface.create({ headless: true, guard: allowAll });
    try {
      await surface.navigate(`${BASE}/prg`);
      surface.takeNavigation(); // drain the entry GET
      await surface.click({
        primary: { strategy: "role", role: "button", name: "Submit PRG", nameMatch: "exact", nth: 0 },
        fallbacks: [],
      });
      expect(surface.currentUrl()).toContain("/prg-done"); // the redirect really happened
      expect(surface.takeNavigation()?.method).toBe("POST");
    } finally {
      await surface.close();
    }
  }, 30000);

  it("still reports GET for a plain GET submission", async () => {
    const surface = await BrowserSurface.create({ headless: true, guard: allowAll });
    try {
      await surface.navigate(`${BASE}/get-form`);
      surface.takeNavigation();
      await surface.click({
        primary: { strategy: "role", role: "button", name: "Submit GET", nameMatch: "exact", nth: 0 },
        fallbacks: [],
      });
      expect(surface.takeNavigation()?.method).toBe("GET");
    } finally {
      await surface.close();
    }
  }, 30000);

  it("clears after a read, so a later non-navigating step inherits nothing", async () => {
    const surface = await BrowserSurface.create({ headless: true, guard: allowAll });
    try {
      await surface.navigate(`${BASE}/prg`);
      expect(surface.takeNavigation()).toBeDefined();
      expect(surface.takeNavigation()).toBeUndefined();
    } finally {
      await surface.close();
    }
  }, 30000);
});

describe("extractText", () => {
  it("returns the selected option of a <select>, not every option", async () => {
    // Regression: innerText on a <select> concatenates all option labels, so
    // extracting from a dropdown produced "Savings\nChecking\nCertificate of
    // Deposit" instead of the chosen value. observe() already read selects
    // correctly, so extraction disagreed with perception.
    const surface = await BrowserSurface.create({ headless: true, guard: allowAll });
    try {
      await surface.navigate(`${BASE}/controls`);
      const value = await surface.extractText({
        primary: { strategy: "css", selector: "#acct", nth: 0 },
        fallbacks: [],
      });
      expect(value).toBe("Checking");
    } finally {
      await surface.close();
    }
  }, 30000);

  it("returns an input's value and an element's text", async () => {
    const surface = await BrowserSurface.create({ headless: true, guard: allowAll });
    try {
      await surface.navigate(`${BASE}/controls`);
      expect(
        await surface.extractText({ primary: { strategy: "css", selector: "#amount", nth: 0 }, fallbacks: [] })
      ).toBe("250");
      expect(
        await surface.extractText({ primary: { strategy: "css", selector: "#para", nth: 0 }, fallbacks: [] })
      ).toBe("Just text");
    } finally {
      await surface.close();
    }
  }, 30000);
});
