import { loadEnvFile } from "./util/env.js";
loadEnvFile();

import { runDiscovery } from "./agent/discover.js";
import { replay } from "./replay/replay.js";
import { listCapabilities, getCapability } from "./catalog/catalog.js";

type Flags = Record<string, string | true>;

function parseArgs(args: string[]): { positional: string[]; flags: Flags; params: Record<string, string> } {
  const positional: string[] = [];
  const flags: Flags = {};
  const params: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (key === "param") {
        const kv = args[++i] ?? "";
        const eq = kv.indexOf("=");
        if (eq === -1) throw new Error(`--param expects key=value, got: ${kv}`);
        params[kv.slice(0, eq)] = kv.slice(eq + 1);
        continue;
      }
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags, params };
}

function requireFlag(flags: Flags, key: string): string {
  const v = flags[key];
  if (typeof v !== "string") throw new Error(`missing required flag --${key}`);
  return v;
}

async function cmdDiscover(args: string[]) {
  const { flags, params } = parseArgs(args);
  const goal = requireFlag(flags, "goal");
  const target = requireFlag(flags, "target");
  const name = requireFlag(flags, "name");

  const result = await runDiscovery({
    goal,
    targetUrl: target,
    name,
    description: typeof flags.description === "string" ? flags.description : undefined,
    params,
    headless: flags.headless === true || flags.headless === "true",
    maxSteps: typeof flags["max-steps"] === "string" ? Number(flags["max-steps"]) : undefined,
    provider: typeof flags.provider === "string" ? flags.provider : undefined,
    model: typeof flags.model === "string" ? flags.model : undefined,
  });

  if (result.status === "success") {
    console.log(`\nDiscovery succeeded. Capability written to ${result.artifactPath}`);
    console.log(`Evidence: ${result.runDir}`);
  } else {
    console.log(`\nDiscovery aborted (see evidence for details): ${result.runDir}`);
    process.exitCode = 1;
  }
}

async function cmdReplay(args: string[]) {
  const { flags } = parseArgs(args);
  const name = requireFlag(flags, "capability");
  const artifact = getCapability(name);
  if (!artifact) {
    console.error(`no capability named "${name}" found in artifacts/. Run \`npm run catalog\` to list available capabilities.`);
    process.exitCode = 1;
    return;
  }
  const params = typeof flags.params === "string" ? JSON.parse(flags.params) : {};

  const result = await replay({
    artifact,
    params,
    headless: flags.headed === true ? false : true,
    allowRisky: flags["allow-risky"] === true || flags["allow-risky"] === "true",
    escalateOnRisky: flags["escalate-on-risky"] === true,
    escalateOnHardFailure: flags["escalate-on-hard-failure"] === true,
  });

  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.status === "failure" ? 1 : 0;
}

function cmdCatalog(args: string[]) {
  const { positional } = parseArgs(args);
  const sub = positional[0] ?? "list";

  if (sub === "show") {
    const name = positional[1];
    if (!name) throw new Error("usage: catalog show <name>");
    const cap = getCapability(name);
    if (!cap) {
      console.error(`no capability named "${name}"`);
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify(cap, null, 2));
    return;
  }

  const caps = listCapabilities();
  if (caps.length === 0) {
    console.log("No capabilities recorded yet. Run `npm run discover -- --goal ... --target ... --name ...` first.");
    return;
  }
  for (const c of caps) {
    console.log(`\n${c.name}  (v${c.version})`);
    console.log(`  ${c.description}`);
    console.log(`  goal: ${c.goal}`);
    console.log(
      `  inputs:  ${c.inputs.map((i) => `${i.name}:${i.type}${i.required ? "" : "?"}`).join(", ") || "(none)"}`
    );
    console.log(`  outputs: ${c.outputs.map((o) => `${o.name}:${o.type}`).join(", ") || "(none)"}`);
    console.log(`  steps: ${c.steps.length}${c.steps.some((s) => s.risky) ? " (includes risky step)" : ""}`);
  }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "discover":
      await cmdDiscover(rest);
      break;
    case "replay":
      await cmdReplay(rest);
      break;
    case "catalog":
      cmdCatalog(rest);
      break;
    default:
      console.error("usage: cli.ts <discover|replay|catalog> [...flags]");
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
