import os from "node:os";
import path from "node:path";
import { afterAll, afterEach } from "vitest";
import {
  formatProcessKillViolations,
  installProcessKillGuard,
  takeProcessKillViolations,
} from "./processKillGuard.js";

/**
 * Canopy settings a developer may export in their shell. A trace path would have
 * tests append fixture readings to the real training-data file, and a background
 * pace would change what the service tests read.
 */
export const SCRUBBED_ENV_VARS = [
  "DAINTREE_CANOPY_TRACE",
  "DAINTREE_CANOPY_BACKGROUND_POLL_MS",
] as const;

/**
 * `hardenedGit` resolves an app-owned `core.hooksPath` from DAINTREE_USER_DATA,
 * falling back to the real home directory when nothing else is available. Any
 * test that builds a git factory would otherwise create `~/.daintree/git-hooks`
 * on the developer's machine. Point it at a temp root instead; suites that
 * inspect the directory (hardenedGit's own) override this with their own
 * mkdtemp before their first factory call.
 *
 * Assigned unconditionally: an inherited empty or relative value would survive
 * `??=` and land right back on the home directory, and an inherited real
 * userData path would let a test suite write into the developer's own app data.
 * Keyed by pid so a stale hook file from an earlier run can't be dispatched by
 * a later one.
 */
export function isolateTestEnvironment(): void {
  process.env.DAINTREE_USER_DATA = path.join(
    os.tmpdir(),
    `daintree-vitest-userdata-${process.pid}`
  );
  for (const name of SCRUBBED_ENV_VARS) delete process.env[name];
}

/**
 * Everything a vitest setup file must apply so a test run can't reach the
 * developer's real machine. Shared by the unit and integration configs so the
 * two can't drift apart: the integration suites spawn and signal real
 * processes and drive real git, which is where these guards matter most.
 *
 * Must be called at the top level of a setup file, where the hooks register.
 */
export function installTestIsolation(): void {
  isolateTestEnvironment();

  // Mock ptys carry made-up PIDs, and a real ProcessTreeKiller signals whatever
  // owns them: one test SIGKILLed the developer's running Daintree at pid 456
  // (#14418). Only this worker and its own children can be signalled; anything
  // else is refused, and because kill paths swallow errors, the refusal fails
  // the test from here.
  installProcessKillGuard();
  const failOnProcessKillViolations = () => {
    const violations = takeProcessKillViolations();
    if (violations.length > 0) throw new Error(formatProcessKillViolations(violations));
  };
  afterEach(failOnProcessKillViolations);
  afterAll(failOnProcessKillViolations);
}
