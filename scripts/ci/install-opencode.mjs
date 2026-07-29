#!/usr/bin/env node
// Single source of truth for the OpenCode CLI version CI installs (#11476).
//
// The online E2E suite gates release publishes, so an unrelated upstream
// publish must not be able to change what that gate runs against. Three
// workflows install this CLI (e2e.yml, e2e-single.yml, screenshots.yml); before
// this wrapper each ran `npm install -g opencode-ai` unpinned and could
// therefore pick up a different build on any given day.
//
// The pin is reproducibility, NOT a claim that this version is free of the
// keymap crash tracked in #11476 — no fixed upstream release is known, and
// `opencode-ai` publishes no stable/lts dist-tag to defer to, so an exact
// x.y.z is the only option. Two limits worth knowing: the pin fixes the
// initially installed artifact only, since the CLI can self-update at runtime
// (which is why the spec still handles a needs-restart), and bumping it is a
// deliberate edit here rather than a silent drift.
//
// Deliberately no CLI/env override: an escape hatch that silently bypasses the
// pin would defeat the point of having one.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const OPENCODE_PACKAGE_SPEC = "opencode-ai@1.18.9";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Args handed to the shared retry wrapper — exported so tests can assert the pin reaches it. */
export function buildInstallArgs() {
  return [path.join(here, "npm-install-retry.mjs"), "-g", OPENCODE_PACKAGE_SPEC];
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  // process.execPath + no shell keeps this identical under bash and pwsh.
  const result = spawnSync(process.execPath, buildInstallArgs(), { stdio: "inherit" });

  if (result.error) {
    console.error(`[install-opencode] failed to start installer: ${result.error.message}`);
    process.exit(1);
  }
  if (result.signal) {
    console.error(`[install-opencode] installer exited via signal ${result.signal}`);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}
