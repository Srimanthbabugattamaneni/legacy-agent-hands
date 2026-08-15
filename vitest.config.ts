import { defineConfig } from "vitest/config";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export default defineConfig({
  test: {
    env: {
      // Runs write their evidence somewhere disposable: the suite exercises
      // the real logging path, but a test run shouldn't scatter directories
      // through the repository it is testing.
      EVIDENCE_DIR: mkdtempSync(path.join(tmpdir(), "lah-evidence-")),
    },
    // The integration suites each bind port 4000 for the mock bank, so they
    // must not run concurrently.
    fileParallelism: false,
  },
});
