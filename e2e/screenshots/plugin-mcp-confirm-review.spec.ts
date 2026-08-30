/**
 * Plugin-MCP consent-dialog visual-review harness (#11982).
 *
 * `PluginMcpConfirmDialog` is the trust-on-first-use consent surface for a tool
 * call originating inside a plugin's own bundled MCP server. Unlike
 * `McpConfirmDialog` — which gates Daintree's *own* registry actions, classified
 * by Daintree — this one gates a tool whose description, input schema and danger
 * annotations are authored by the third party being approved, and whose approval
 * is PINNED: "Allow and remember" writes a fingerprint into the TOFU store and
 * every matching future call runs silently.
 *
 * That makes the surface answer more questions at once than a one-shot confirm:
 * who is asking (plugin, its server, the tool), what it practically does, how
 * far the approval reaches, and — on a re-prompt — what changed since it was
 * last approved. Those axes cross into more states than anyone reads the JSX
 * for, so the surface is judged on rendered pixels.
 *
 * States are parked directly in the consent queue through the E2E store
 * backdoor (`window.__DAINTREE_E2E_ENQUEUE_PLUGIN_MCP_CONFIRM__`, installed by
 * `useE2EBridges` under DAINTREE_E2E_MODE) rather than by standing up a real
 * plugin host, a real MCP server and a real fingerprint mismatch — the store IS
 * the seam `PluginMcpConsentService` writes through, so the dialog renders
 * exactly what it renders in the app.
 *
 *   first-use    the baseline: nothing pinned yet, no change warning.
 *   reasons      the four re-prompt causes — description bytes changed, input
 *                schema changed, danger annotations changed, previously
 *                revoked. Each must be tellable apart from first-use AND from
 *                each other; an annotation-changed prompt that reads like a
 *                first-use one is the rug-pull case.
 *   tiers        D0/D1/D2/D3. D2 and D3 currently share one badge label even
 *                though their blast radius differs.
 *   capabilities none declared, and the full manifest list.
 *   args         empty on a D2 (the block still renders), and a long redacted
 *                blob.
 *   overflow     hostile lengths — long plugin display name, long server id,
 *                long tool name, long description. Proves the action row and
 *                the identity block survive.
 *   queued       three concurrent tool calls; only the head is visible.
 *   cooldown     captured inside the destructive read-time gate, so the primary
 *                button is disabled for a reason the user must be able to tell
 *                apart from a broken action.
 *   focus        keyboard focus ring, first and second stop.
 *   contrast     prefers-contrast: more.
 *   forced       forced-colors: active.
 *
 * Opt-in only, like mcp-confirm-review: skips itself unless
 * DAINTREE_SHOT_PLUGIN_MCP is set, so the marketing screenshots workflow never
 * runs it.
 *
 *   DAINTREE_SHOT_PLUGIN_MCP=1 npx playwright test --project=screenshots plugin-mcp-confirm-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_PLUGIN_MCP  required — any truthy value runs the capture
 *   DAINTREE_SHOT_THEME       optional theme id (default: the app default)
 *   DAINTREE_SHOT_TAG         optional suffix so rounds sit side by side
 *   DAINTREE_SHOT_ONLY        comma-separated step filter (see step names above)
 *   DAINTREE_SHOT_OUT         optional absolute output dir (default: artifacts/…)
 *
 * Output: artifacts/plugin-mcp-confirm-shots/<NN-slug>[-tag].png (gitignored).
 */

import { test, expect, type Page } from "@playwright/test";
import { execSync } from "child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { setAppTheme } from "../helpers/theme";
import { SEL } from "../helpers/selectors";
import { T_LONG } from "../helpers/timeouts";

const ENABLED = !!process.env.DAINTREE_SHOT_PLUGIN_MCP;
const THEME = process.env.DAINTREE_SHOT_THEME ?? "";
const TAG = process.env.DAINTREE_SHOT_TAG ? `-${process.env.DAINTREE_SHOT_TAG}` : "";
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";
const OUTPUT_DIR =
  process.env.DAINTREE_SHOT_OUT ??
  path.resolve(process.cwd(), "artifacts", "plugin-mcp-confirm-shots");

/**
 * The dialog CARD, so the shot is the consent surface rather than the whole app.
 * Not `[role="dialog"]` — `AppDialog` puts the role on the full-viewport
 * backdrop, so a role-based locator silently screenshots the entire window and
 * every "crop" comes back identical to the in-window shot.
 */
const DIALOG_BACKDROP = "[data-app-dialog-surface]";
const DIALOG = `${DIALOG_BACKDROP} > div`;

const POLISH_CSS = `
  ::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
  }
`;

function git(cmd: string, cwd: string): void {
  execSync(`git ${cmd}`, { cwd, stdio: "ignore" });
}

/** Minimal repo so the app has a project view to mount the singleton dialog in. */
function createFixtureRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "daintree-pmcp-shots-"));
  const wtRoot = path.join(path.dirname(dir), path.basename(dir) + "-worktrees");
  mkdirSync(wtRoot, { recursive: true });

  git("init -b main", dir);
  git('config user.email "test@daintree.dev"', dir);
  git('config user.name "Daintree Test"', dir);
  writeFileSync(path.join(dir, "README.md"), "# Helios Dashboard\n");
  git("add -A", dir);
  git('commit -m "initial commit"', dir);
  git("branch develop", dir);
  git("checkout develop", dir);

  return {
    dir,
    cleanup: () => {
      if (existsSync(wtRoot)) rmSync(wtRoot, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// Fixture payloads. Deliberately realistic: `argsSummary` is the shape
// `summarizeMcpArgs` actually produces (single-level, redacted), capability
// tokens are real `BUILT_IN_PLUGIN_CAPABILITIES` entries, and descriptions are
// written the way a third-party MCP server actually writes them — which is to
// say, not written for this dialog.
// ---------------------------------------------------------------------------

const DESC_DEPLOY =
  "Deploy the current branch to the configured Fly.io app. Runs `flyctl deploy` with the project's fly.toml, waits for the health checks to pass, and rolls back automatically if any machine fails to come up.";

const DESC_SHORT = "Read the contents of a file in the current worktree.";

const DESC_LONG =
  "Synchronise the local issue cache with the upstream tracker. This walks every open issue in the configured project, reconciles labels, assignees, milestones and linked pull requests against the local SQLite mirror, then writes back any locally-modified fields that have not been touched upstream since the last sync. Conflicting fields are resolved in favour of upstream unless `preferLocal` is set. The operation is incremental after the first run and typically completes in under two seconds; a full resync of a large project can take several minutes and will hold a write lock on the mirror for its duration. Network failures are retried with exponential backoff up to five times before the operation aborts and leaves the mirror untouched.";

const ARGS_SHORT = '{\n  "path": "src/index.ts"\n}';

const ARGS_DEPLOY = [
  "{",
  '  "app": "helios-dashboard-prod",',
  '  "strategy": "rolling",',
  '  "apiToken": "[redacted]"',
  "}",
].join("\n");

const ARGS_LONG = [
  "{",
  '  "app": "helios-dashboard-prod",',
  '  "region": "syd",',
  '  "strategy": "immediate",',
  '  "force": true,',
  '  "detach": false,',
  '  "buildSecrets": "[redacted]",',
  '  "apiToken": "[redacted]",',
  '  "deployToken": "[redacted]",',
  '  "imageLabel": "sha-9f2c1ab4e77d0356bb18e4a2c9f0d51e73a8b6c4",',
  '  "env": "[redacted]",',
  '  "buildArgs": "[redacted]",',
  '  "healthCheckTimeoutSeconds": 300,',
  '  "releaseCommand": "npm run db:migrate -- --yes --no-interactive",',
  '  "waitTimeout": "15m0s"',
  "}",
].join("\n");

/**
 * Real `BUILT_IN_PLUGIN_CAPABILITIES` tokens (shared/types/plugin.ts). Typed as
 * the literal union rather than `string[]` so a fixture that invents a
 * capability the host does not know about fails here instead of rendering a
 * plausible-looking lie.
 */
type Capability =
  | "fs:project-read"
  | "fs:project-write"
  | "fs:user-data-read"
  | "fs:user-data-write"
  | "network:fetch"
  | "agent:invoke"
  | "agent:read"
  | "agent:register"
  | "agent:input"
  | "git:read"
  | "git:write"
  | "clipboard:read"
  | "clipboard:write"
  | "shell:exec"
  | "socket:connect";

const CAPS_FEW: readonly Capability[] = ["git:read", "network:fetch"];

const CAPS_MANY: readonly Capability[] = [
  "fs:project-read",
  "fs:project-write",
  "fs:user-data-read",
  "fs:user-data-write",
  "network:fetch",
  "agent:invoke",
  "agent:read",
  "git:read",
  "git:write",
  "clipboard:write",
  "shell:exec",
  "socket:connect",
];

const LONG_PLUGIN_NAME =
  "Continuous Delivery Toolkit for Fly.io, Railway and Render (Community Edition)";
const LONG_SERVER_ID = "continuous-delivery-toolkit-multi-provider-deployment-server-v2";
const LONG_TOOL_NAME = "deploy_current_branch_to_configured_provider_with_health_checks";

type ShotPayload = {
  requestId: string;
  pluginId: string;
  serverId: string;
  toolName: string;
  pluginDisplayName: string;
  descriptionDisplay: string;
  argsSummary: string;
  dangerTier: "D0" | "D1" | "D2" | "D3";
  declaredCapabilities: readonly Capability[];
  reason:
    | "first-use"
    | "raw-changed"
    | "schema-changed"
    | "annotation-changed"
    | "revoked"
    | "explicit-confirm";
};

/** Mirrors CONFIRM_COOLDOWN_MS in src/components/Plugin/PluginMcpConfirmDialog.tsx. */
const CONFIRM_COOLDOWN_MS = 1_200;

/** The workhorse fixture: a deploy tool from a CD plugin. D2 by default. */
function deployTool(over: Partial<ShotPayload> = {}): ShotPayload {
  return {
    requestId: `shot-${Math.abs(hash(JSON.stringify(over)))}`,
    pluginId: "flightdeck",
    serverId: "flightdeck-mcp",
    toolName: "deploy_branch",
    pluginDisplayName: "Flightdeck",
    descriptionDisplay: DESC_DEPLOY,
    argsSummary: ARGS_DEPLOY,
    dangerTier: "D2",
    declaredCapabilities: CAPS_FEW,
    reason: "first-use",
    ...over,
  };
}

/** Stable id per payload so a re-run of one step reuses its cooldown key. */
function hash(value: string): number {
  let h = 0;
  for (let i = 0; i < value.length; i++) h = (Math.imul(31, h) + value.charCodeAt(i)) | 0;
  return h;
}

// ---------------------------------------------------------------------------

async function settle(page: Page, ms = 350): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

/**
 * Screenshot a state. `snap` is the only thing that writes a PNG, and it waits
 * for the dialog to actually be on screen first — a shot taken of an empty
 * workbench because a state failed to park is a plausible-looking artifact that
 * would poison the review.
 */
async function snap(page: Page, slug: string, locator?: string): Promise<void> {
  await settle(page);
  const file = path.join(OUTPUT_DIR, `${slug}${TAG}.png`);
  if (locator) {
    const target = page.locator(locator).last();
    await target.waitFor({ state: "visible", timeout: 5000 });
    await target.screenshot({ path: file, type: "png" });
  } else {
    await page.screenshot({ path: file, type: "png", animations: "disabled", caret: "hide" });
  }
}

/** Clear the queue, then park exactly these items (FIFO — index 0 becomes visible). */
async function park(page: Page, items: ShotPayload[]): Promise<void> {
  await page.evaluate((payloads) => {
    window.__DAINTREE_E2E_RESET_PLUGIN_MCP_CONFIRM__?.();
    for (const payload of payloads) {
      window.__DAINTREE_E2E_ENQUEUE_PLUGIN_MCP_CONFIRM__?.(payload);
    }
  }, items);
  await page.locator(DIALOG).last().waitFor({ state: "visible", timeout: 8000 });
  // Past the destructive read-time gate, so a state captured through park() shows
  // the primary button ENABLED. Without this every D2/D3 shot silently captures
  // the 1.2s cooldown and the review scores a disabled button as the resting state.
  await page.waitForTimeout(CONFIRM_COOLDOWN_MS + 300);
}

async function clearQueue(page: Page): Promise<void> {
  await page.evaluate(() => window.__DAINTREE_E2E_RESET_PLUGIN_MCP_CONFIRM__?.());
  await page
    .locator(DIALOG)
    .last()
    .waitFor({ state: "hidden", timeout: 5000 })
    .catch(() => {});
}

/**
 * Every built-in theme. Switching themes in place crashes the project view
 * under this harness (same constraint as mcp-confirm-review), so the sweep
 * boots once per theme:
 *
 *   for t in <these ids>; do
 *     DAINTREE_SHOT_PLUGIN_MCP=1 DAINTREE_SHOT_THEME=$t DAINTREE_SHOT_TAG=$t \
 *     npx playwright test --project=screenshots plugin-mcp-confirm-review
 *   done
 */
export const ALL_THEMES = [
  "arashiyama",
  "atacama",
  "bali",
  "bondi",
  "daintree",
  "fiordland",
  "galapagos",
  "highlands",
  "hokkaido",
  "movile",
  "namib",
  "redwoods",
  "serengeti",
  "svalbard",
  "table-mountain",
];

const ONLY = (process.env.DAINTREE_SHOT_ONLY ?? "").split(",").filter(Boolean);

// A failed step must not abort the run — the other shots are still worth
// having. But the run must still FAIL, or a silent exit 0 with a half-empty
// output directory reads as success.
const failures: string[] = [];
async function step(page: Page, name: string, fn: () => Promise<void>): Promise<void> {
  if (ONLY.length > 0 && !ONLY.includes(name)) return;
  try {
    await fn();
  } catch (error) {
    const detail = String(error).slice(0, 300);
    console.warn(`[plugin-mcp-shots] step "${name}" failed:`, detail);
    failures.push(`${name}: ${detail}`);
  } finally {
    // Unconditionally: a step that dies holding an open modal would wedge every
    // step after it.
    await clearQueue(page).catch((error) => {
      failures.push(`${name} (reset): ${String(error).slice(0, 200)}`);
    });
  }
}

test("Plugin-MCP consent dialog review — identity, persistence scope, and re-prompt cause", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_PLUGIN_MCP is required for the consent-dialog capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_PLUGIN_MCP to run the consent-dialog capture");

  // Module-scoped so `step()` can reach it; cleared here so a Playwright retry
  // starts from a clean slate rather than inheriting the previous attempt's.
  failures.length = 0;

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const repo = createFixtureRepo();
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-pmcpshot-"));
  let ctx: AppContext | undefined;
  let expectedShots = 0;
  try {
    ctx = await launchApp({
      userDataDir,
      screenshotScale: SCALE,
      windowSize: { width: 1680, height: 1050 },
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
    });
    const page = await openAndOnboardProject(ctx.app, ctx.window, repo.dir, "Helios Dashboard");
    if (THEME) await setAppTheme(page, THEME);
    await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
    await dismissBlockingPalette(page);
    await page
      .locator(SEL.worktree.mainCard)
      .waitFor({ state: "visible", timeout: T_LONG })
      .catch(() => {});
    await settle(page, 1500);
    await dismissBlockingPalette(page);

    // The backdoor is the whole harness. If it never attached, every later step
    // would "succeed" against an empty workbench, so fail loudly here instead.
    const hasBackdoor = await page.evaluate(
      () => typeof window.__DAINTREE_E2E_ENQUEUE_PLUGIN_MCP_CONFIRM__ === "function"
    );
    expect(
      hasBackdoor,
      "Plugin-MCP consent E2E backdoor is not installed (DAINTREE_E2E_MODE?)"
    ).toBe(true);

    // ---- First use: the baseline -------------------------------------------
    await step(page, "first-use", async () => {
      await park(page, [
        deployTool({
          requestId: "shot-first-use-d1",
          toolName: "read_file",
          descriptionDisplay: DESC_SHORT,
          argsSummary: ARGS_SHORT,
          dangerTier: "D1",
        }),
      ]);
      await snap(page, "10-first-use-d1", DIALOG);
      await snap(page, "11-first-use-d1-in-window");
      expectedShots += 2;

      await park(page, [deployTool({ requestId: "shot-first-use-d2" })]);
      await snap(page, "12-first-use-d2", DIALOG);
      expectedShots++;
    });

    // ---- The four re-prompt reasons ----------------------------------------
    // Every one of these means "you already approved this and something moved".
    // They must be tellable apart from 12 (first-use, same tier, same tool) and
    // from each other — an annotation-changed prompt that reads like a
    // first-use one is exactly the rug-pull the fingerprint exists to catch.
    await step(page, "reasons", async () => {
      await park(page, [deployTool({ requestId: "shot-raw", reason: "raw-changed" })]);
      await snap(page, "20-reason-raw-changed", DIALOG);
      expectedShots++;

      await park(page, [deployTool({ requestId: "shot-schema", reason: "schema-changed" })]);
      await snap(page, "21-reason-schema-changed", DIALOG);
      expectedShots++;

      await park(page, [
        deployTool({ requestId: "shot-annotation", reason: "annotation-changed" }),
      ]);
      await snap(page, "22-reason-annotation-changed", DIALOG);
      expectedShots++;

      await park(page, [deployTool({ requestId: "shot-revoked", reason: "revoked" })]);
      await snap(page, "23-reason-revoked", DIALOG);
      expectedShots++;
    });

    // ---- Danger tiers -------------------------------------------------------
    // D2 and D3 currently render the same "Shared state" badge label even though
    // their blast radius is not the same, and both take destructive styling. 32
    // and 33 exist to be compared directly.
    await step(page, "tiers", async () => {
      await park(page, [
        deployTool({
          requestId: "shot-d0",
          toolName: "list_deployments",
          descriptionDisplay: "List the recent deployments for the configured app.",
          argsSummary: "",
          dangerTier: "D0",
        }),
      ]);
      await snap(page, "30-tier-d0-readonly", DIALOG);
      expectedShots++;

      await park(page, [
        deployTool({
          requestId: "shot-d1",
          toolName: "write_fly_toml",
          descriptionDisplay: "Write the generated fly.toml into the current worktree.",
          argsSummary: '{\n  "path": "fly.toml"\n}',
          dangerTier: "D1",
        }),
      ]);
      await snap(page, "31-tier-d1-local", DIALOG);
      expectedShots++;

      await park(page, [deployTool({ requestId: "shot-d2", dangerTier: "D2" })]);
      await snap(page, "32-tier-d2-shared", DIALOG);
      expectedShots++;

      await park(page, [
        deployTool({
          requestId: "shot-d3",
          toolName: "destroy_app",
          descriptionDisplay:
            "Destroy the configured Fly.io app, its machines, its volumes and its release history.",
          // Its own args, not the deploy fixture's: an inherited `"strategy":
          // "rolling"` renders as real content and reads as nonsense for a
          // destroy call, which would send the review chasing a fixture bug.
          argsSummary: '{\n  "app": "helios-dashboard-prod",\n  "deleteVolumes": true\n}',
          dangerTier: "D3",
        }),
      ]);
      await snap(page, "33-tier-d3-shared", DIALOG);
      expectedShots++;
    });

    // ---- Declared capabilities ---------------------------------------------
    await step(page, "capabilities", async () => {
      await park(page, [deployTool({ requestId: "shot-nocaps", declaredCapabilities: [] })]);
      await snap(page, "40-no-capabilities", DIALOG);
      expectedShots++;

      await park(page, [
        deployTool({ requestId: "shot-manycaps", declaredCapabilities: CAPS_MANY }),
      ]);
      await snap(page, "41-many-capabilities", DIALOG);
      expectedShots++;
    });

    // ---- Argument payloads --------------------------------------------------
    await step(page, "args", async () => {
      // D2 with NO args: the block still renders (showArgsPreview is true for
      // D2+ regardless), so the shot proves what the empty state looks like.
      await park(page, [deployTool({ requestId: "shot-noargs", argsSummary: "" })]);
      await snap(page, "50-args-empty-on-d2", DIALOG);
      expectedShots++;

      await park(page, [deployTool({ requestId: "shot-longargs", argsSummary: ARGS_LONG })]);
      await snap(page, "51-args-long", DIALOG);
      expectedShots++;
    });

    // ---- Hostile lengths ----------------------------------------------------
    await step(page, "overflow", async () => {
      await park(page, [
        deployTool({
          requestId: "shot-overflow",
          pluginDisplayName: LONG_PLUGIN_NAME,
          serverId: LONG_SERVER_ID,
          toolName: LONG_TOOL_NAME,
          descriptionDisplay: DESC_LONG,
          argsSummary: ARGS_LONG,
          declaredCapabilities: CAPS_MANY,
        }),
      ]);
      await snap(page, "60-long-identifiers", DIALOG);
      await snap(page, "61-long-identifiers-in-window");
      expectedShots += 2;

      // Same hostile lengths on a re-prompt, where the title also has to carry
      // the change framing on top of the long tool name.
      await park(page, [
        deployTool({
          requestId: "shot-overflow-reason",
          pluginDisplayName: LONG_PLUGIN_NAME,
          serverId: LONG_SERVER_ID,
          toolName: LONG_TOOL_NAME,
          descriptionDisplay: DESC_LONG,
          reason: "annotation-changed",
        }),
      ]);
      await snap(page, "62-long-identifiers-reprompt", DIALOG);
      expectedShots++;
    });

    // ---- Concurrent tool calls ---------------------------------------------
    await step(page, "queued", async () => {
      await park(page, [
        deployTool({ requestId: "shot-q1" }),
        deployTool({ requestId: "shot-q2", toolName: "scale_machines", dangerTier: "D2" }),
        deployTool({ requestId: "shot-q3", toolName: "read_file", dangerTier: "D0" }),
      ]);
      await snap(page, "70-three-queued-head-visible", DIALOG);
      expectedShots++;

      // The control: the SAME head payload with nothing behind it. If 70 and 71
      // come back byte-identical, the surface tells the approver nothing about
      // how many more tool calls are stacked behind the one they are reading.
      await park(page, [deployTool({ requestId: "shot-q1" })]);
      await snap(page, "71-single-not-queued-control", DIALOG);
      expectedShots++;
    });

    // ---- Cooldown: disabled for a reason ------------------------------------
    await step(page, "cooldown", async () => {
      // No settle before the shot — the destructive read-time gate is only
      // 1200ms, so this has to be captured immediately after parking.
      await page.evaluate(() => {
        window.__DAINTREE_E2E_RESET_PLUGIN_MCP_CONFIRM__?.();
        window.__DAINTREE_E2E_ENQUEUE_PLUGIN_MCP_CONFIRM__?.({
          requestId: "shot-cooldown",
          pluginId: "flightdeck",
          serverId: "flightdeck-mcp",
          toolName: "deploy_branch",
          pluginDisplayName: "Flightdeck",
          descriptionDisplay:
            "Deploy the current branch to the configured Fly.io app. Runs `flyctl deploy` with the project's fly.toml, waits for the health checks to pass, and rolls back automatically if any machine fails to come up.",
          argsSummary:
            '{\n  "app": "helios-dashboard-prod",\n  "strategy": "rolling",\n  "apiToken": "[redacted]"\n}',
          dangerTier: "D2",
          declaredCapabilities: ["git:read", "network:fetch"],
          reason: "first-use",
        });
      });
      await page.locator(DIALOG).last().waitFor({ state: "visible", timeout: 8000 });
      const file = path.join(OUTPUT_DIR, `80-cooldown-active${TAG}.png`);
      await page.locator(DIALOG).last().screenshot({ path: file, type: "png" });
      expectedShots++;

      // And the same dialog once the gate clears, so the two are comparable.
      await page.waitForTimeout(1600);
      await snap(page, "81-cooldown-cleared", DIALOG);
      expectedShots++;
    });

    // ---- Keyboard focus ----------------------------------------------------
    await step(page, "focus", async () => {
      await park(page, [deployTool({ requestId: "shot-focus" })]);
      await snap(page, "90-keyboard-focus-initial", DIALOG);
      await page.keyboard.press("Tab");
      await snap(page, "91-keyboard-focus-first-tab", DIALOG);
      await page.keyboard.press("Tab");
      await snap(page, "92-keyboard-focus-second-tab", DIALOG);
      expectedShots += 3;
    });

    // ---- Accessibility media modes -----------------------------------------
    await step(page, "contrast", async () => {
      await page.emulateMedia({ contrast: "more" }).catch(() => {});
      await park(page, [deployTool({ requestId: "shot-contrast", reason: "annotation-changed" })]);
      await snap(page, "95-prefers-contrast-more", DIALOG);
      expectedShots++;
      await page.emulateMedia({ contrast: "no-preference" }).catch(() => {});
    });

    await step(page, "forced", async () => {
      await page.emulateMedia({ forcedColors: "active" }).catch(() => {});
      await park(page, [deployTool({ requestId: "shot-forced", reason: "annotation-changed" })]);
      await snap(page, "96-forced-colors-active", DIALOG);
      expectedShots++;

      // D0 under forced-colors too: with the destructive fill flattened away,
      // a read-only prompt and a shared-state prompt must still differ.
      await park(page, [
        deployTool({
          requestId: "shot-forced-d0",
          toolName: "list_deployments",
          descriptionDisplay: "List the recent deployments for the configured app.",
          argsSummary: "",
          dangerTier: "D0",
        }),
      ]);
      await snap(page, "97-forced-colors-d0", DIALOG);
      expectedShots++;
      await page.emulateMedia({ forcedColors: "none" }).catch(() => {});
    });
  } finally {
    // Each cleanup runs even if an earlier one throws.
    if (ctx?.app) await closeApp(ctx.app).catch(() => {});
    try {
      repo.cleanup();
    } catch {
      /* best effort */
    }
    try {
      rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `[plugin-mcp-shots] ${failures.length} step(s) failed:\n${failures.join("\n")}`
    );
  }

  // Count the files rather than trusting the exit code: a harness that reports
  // success while writing nothing is worse than one that fails.
  const written = readdirSync(OUTPUT_DIR).filter(
    (f) => f.endsWith(`${TAG}.png`) || (TAG === "" && f.endsWith(".png"))
  );
  expect(
    written.length,
    `[plugin-mcp-shots] expected ${expectedShots} PNGs in ${OUTPUT_DIR}, found ${written.length}`
  ).toBeGreaterThanOrEqual(expectedShots);
});
