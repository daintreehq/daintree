/**
 * Worktree environment popover visual-review harness.
 *
 * The sibling of `worktree-card-review.spec.ts`, scoped to the environment icon
 * in the card header and the popover it opens. Every field the popover shows is
 * produced by the app's own resource pipeline, not patched into a store:
 *   - The environments are a `resources` block in the fixture's committed
 *     `.daintree/config.json`, approved through the same host request the
 *     approval dialog uses.
 *   - Their icons come from project settings (`resourceEnvironments`), saved
 *     through the `project.saveSettings` action.
 *   - A worktree enters an environment through `switch-worktree-environment`.
 *   - Status, endpoint and last output are whatever the status command printed,
 *     parsed by `ResourceActionExecutor`. The helper script reads a per-worktree
 *     scenario file, so each state is one file write plus a real status check.
 *   - "Lifecycle running" is a real provision command that sleeps.
 *
 * Opt-in only: skips itself unless DAINTREE_SHOT_ENV is set.
 *
 *   DAINTREE_SHOT_ENV=1 npx playwright test --project=screenshots worktree-environment-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_ENV      required — any truthy value runs the capture
 *   DESIGN_CAPTURE_DIR     output directory (default artifacts/env-shots, gitignored)
 *   DAINTREE_SHOT_TAG      optional suffix so review rounds sit side by side
 *   DAINTREE_SHOT_ONLY     comma-separated step filter (step names below)
 *   DAINTREE_SHOT_THEMES   comma-separated theme sweep (default: every built-in)
 *
 * Like its sibling, it never writes a PNG it has not verified: the popover must
 * be open, carry the status label the scenario produced, and have a real box.
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import { execFileSync } from "child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { setAppTheme } from "../helpers/theme";
import { saveCurrentProjectSettings } from "../helpers/projectSettings";
import {
  approveWorktreeCommands,
  commandArg,
  nodeScriptCommand,
} from "../helpers/resource-lifecycle";
import { SEL } from "../helpers/selectors";
import { T_LONG } from "../helpers/timeouts";

const ENABLED = !!process.env.DAINTREE_SHOT_ENV;
const TAG = process.env.DAINTREE_SHOT_TAG ? `-${process.env.DAINTREE_SHOT_TAG}` : "";
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";
const OUTPUT_DIR = process.env.DESIGN_CAPTURE_DIR
  ? path.resolve(process.env.DESIGN_CAPTURE_DIR)
  : path.resolve(process.cwd(), "artifacts", "env-shots");

const ALL_THEMES = [
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

const SWEEP_THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

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

/** Environment names as a user would type them in Settings. */
const ENV_GPU = "staging-gpu";
const ENV_BARE = "edge-lab";

const WORKTREES = {
  /** Lives in `staging-gpu` (custom Cpu icon) and cycles through every status. */
  gpu: { branch: "feature/issue-5120-batch-inference-on-gpu", slug: "gpu-inference" },
  /** Lives in `edge-lab`: no icon chosen, no status command — the sparse case. */
  bare: { branch: "feature/edge-cache-warmup", slug: "edge-cache" },
  /** Stays local, but the repo's default `resource` block gives it a status. */
  local: { branch: "fix/local-postgres-seed", slug: "local-postgres" },
} as const;

interface Scenario {
  /** What the status command prints. */
  stdout: string;
  /** Its exit code — non-JSON output with a non-zero exit reads as unhealthy. */
  exit?: number;
}

const LONG_LOG = [
  "[2026-09-23T09:14:02.118Z] probe: GET https://gpu-5120.staging.helios.dev/healthz",
  "[2026-09-23T09:14:02.412Z] probe: connected to 10.42.7.19:8443 (tls1.3, h2)",
  "[2026-09-23T09:14:07.413Z] probe: timeout after 5000ms waiting for response headers",
  "[2026-09-23T09:14:07.414Z] retry 1/3 in 2000ms",
  "[2026-09-23T09:14:09.420Z] probe: GET https://gpu-5120.staging.helios.dev/healthz",
  "[2026-09-23T09:14:14.421Z] probe: timeout after 5000ms waiting for response headers",
  "[2026-09-23T09:14:14.422Z] retry 2/3 in 4000ms",
  "[2026-09-23T09:14:18.430Z] probe: GET https://gpu-5120.staging.helios.dev/healthz",
  "[2026-09-23T09:14:18.911Z] probe: 503 Service Unavailable",
  '[2026-09-23T09:14:18.912Z] body: {"error":"cuda_init_failed","device":"nvidia-a10g-0","detail":"CUDA_ERROR_OUT_OF_MEMORY: out of memory while allocating 17179869184 bytes for the KV cache"}',
  "[2026-09-23T09:14:18.913Z] kubectl -n helios-staging get pod inference-5120-7c9d8f6b5-x2kqp",
  "NAME                                READY   STATUS             RESTARTS      AGE",
  "inference-5120-7c9d8f6b5-x2kqp      0/1     CrashLoopBackOff   6 (41s ago)   9m12s",
  "[2026-09-23T09:14:19.001Z] giving up: environment unhealthy",
].join("\n");

const LONG_ENDPOINT =
  "https://gpu-5120-batch-inference-on-gpu.preview.staging.helios-internal.dev:8443/v2/models/llama-helios-70b-instruct/infer?tenant=avery-lindqvist";

const SCENARIOS: Record<string, Scenario> = {
  ready: {
    stdout: JSON.stringify({
      status: "ready",
      endpoint: "https://gpu-5120.staging.helios.dev",
    }),
  },
  provisioning: {
    stdout: JSON.stringify(
      {
        status: "provisioning",
        meta: { node: "a10g-spot-3", queue: "2 of 5", eta: "about 3 minutes" },
      },
      null,
      2
    ),
  },
  unhealthy: { stdout: LONG_LOG, exit: 1 },
  paused: {
    stdout: JSON.stringify({ status: "paused", endpoint: "https://gpu-5120.staging.helios.dev" }),
  },
  degraded: {
    stdout: JSON.stringify(
      {
        status: "degraded",
        endpoint: LONG_ENDPOINT,
        meta: {
          replicas: { desired: 3, ready: 1 },
          lastEvent: "Readiness probe failed: HTTP probe failed with statuscode: 503",
          node: "ip-10-42-7-19.us-west-2.compute.internal",
        },
      },
      null,
      2
    ),
  },
  minimal: { stdout: JSON.stringify({ status: "ready" }) },
};

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

interface FixtureRepo {
  dir: string;
  worktreeRoot: string;
  scenarioDir: string;
  cleanup: () => void;
}

/**
 * The status helper answers per worktree: it reads
 * `<scenarioDir>/<worktree folder>.json` and prints its `stdout` with its exit
 * code. `provision` sleeps for as long as `<folder>.provision-ms` says, which is
 * what holds the lifecycle in its running state for the capture.
 */
function writeHelper(daintreeDir: string, scenarioDir: string): string {
  const scriptPath = path.join(daintreeDir, "env-helper.cjs");
  writeFileSync(
    scriptPath,
    [
      "const fs = require('fs');",
      "const path = require('path');",
      `const dir = ${JSON.stringify(scenarioDir)};`,
      "const key = path.basename(process.env.DAINTREE_WORKTREE_PATH || 'default');",
      "const action = process.argv[2];",
      "if (action === 'status') {",
      "  let s = { stdout: JSON.stringify({ status: 'unknown' }) };",
      "  try { s = JSON.parse(fs.readFileSync(path.join(dir, key + '.json'), 'utf8')); } catch {}",
      "  process.stdout.write(s.stdout);",
      "  process.exit(s.exit || 0);",
      "} else if (action === 'provision') {",
      "  let ms = 0;",
      "  try { ms = Number(fs.readFileSync(path.join(dir, key + '.provision-ms'), 'utf8')); } catch {}",
      "  setTimeout(() => process.exit(0), ms);",
      "} else {",
      "  process.exit(0);",
      "}",
      "",
    ].join("\n")
  );
  return scriptPath;
}

function createFixtureRepo(): FixtureRepo {
  const dir = mkdtempSync(path.join(tmpdir(), "daintree-envshots-"));
  const worktreeRoot = path.join(path.dirname(dir), `${path.basename(dir)}-worktrees`);
  const scenarioDir = path.join(path.dirname(dir), `${path.basename(dir)}-scenarios`);
  mkdirSync(worktreeRoot, { recursive: true });
  mkdirSync(scenarioDir, { recursive: true });

  git(["init", "-b", "main"], dir);
  git(["config", "user.email", "avery@helios.dev"], dir);
  git(["config", "user.name", "Avery Lindqvist"], dir);
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "README.md"), "# Helios Inference\n\nBatch inference service.\n");
  writeFileSync(
    path.join(dir, "src", "index.ts"),
    "export const MODEL = 'llama-helios-70b-instruct';\n"
  );

  const daintreeDir = path.join(dir, ".daintree");
  mkdirSync(daintreeDir, { recursive: true });
  const helper = writeHelper(daintreeDir, scenarioDir);
  const cmd = (action: string) => nodeScriptCommand(helper, [commandArg(action)]);
  const config = {
    setup: [],
    teardown: [],
    // The default block applies to local worktrees too.
    resource: { status: cmd("status") },
    resources: {
      [ENV_GPU]: {
        provision: [cmd("provision")],
        resume: [cmd("provision")],
        teardown: [cmd("teardown")],
        status: cmd("status"),
        statusInterval: 3600,
      },
      // No status command: the popover has nothing to report or refresh.
      [ENV_BARE]: {
        provision: [cmd("provision")],
        teardown: [cmd("teardown")],
      },
    },
  };
  writeFileSync(path.join(daintreeDir, "config.json"), JSON.stringify(config, null, 2));
  git(["add", "-A"], dir);
  git(["commit", "-m", "Set up the inference service with resource environments"], dir);

  for (const wt of Object.values(WORKTREES)) {
    git(["worktree", "add", "-b", wt.branch, path.join(worktreeRoot, wt.slug), "main"], dir);
  }

  return {
    dir,
    worktreeRoot,
    scenarioDir,
    cleanup: () => {
      for (const p of [worktreeRoot, scenarioDir, dir]) {
        if (existsSync(p)) rmSync(p, { recursive: true, force: true });
      }
    },
  };
}

function setScenario(repo: FixtureRepo, slug: string, scenario: Scenario): void {
  writeFileSync(path.join(repo.scenarioDir, `${slug}.json`), JSON.stringify(scenario));
}

async function settle(page: Page, ms = 400): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

const written = new Set<string>();
const ONLY = (process.env.DAINTREE_SHOT_ONLY ?? "").split(",").filter(Boolean);
const stepFailures: string[] = [];

async function step(name: string, fn: () => Promise<void>): Promise<void> {
  if (ONLY.length > 0 && !ONLY.includes(name)) return;
  try {
    await fn();
  } catch (error) {
    const detail = String(error).slice(0, 600);
    stepFailures.push(`${name}: ${detail}`);
    console.warn(`[env-shots] step "${name}" FAILED:`, detail);
  }
}

type Box = { x: number; y: number; width: number; height: number };

function union(a: Box, b: Box): Box {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}

/**
 * Shoot a region that holds every target, padded, so the popover is always seen
 * next to the icon that opened it. Refuses to write unless each target is
 * visible with a real box.
 */
async function snapRegion(
  page: Page,
  slug: string,
  targets: Locator[],
  pad = { x: 48, y: 32 }
): Promise<void> {
  await settle(page);
  let region: Box | null = null;
  for (const target of targets) {
    await expect(target, `"${slug}": target never became visible — refusing to write`).toBeVisible({
      timeout: T_LONG,
    });
    const box = await target.boundingBox();
    if (!box || box.width < 6 || box.height < 6) {
      throw new Error(`"${slug}": target box is ${JSON.stringify(box)} — refusing to write`);
    }
    region = region ? union(region, box) : box;
  }
  if (!region) throw new Error(`"${slug}": no targets`);
  const viewport = page.viewportSize() ?? { width: 1680, height: 1050 };
  const x = Math.max(0, region.x - pad.x);
  const y = Math.max(0, region.y - pad.y);
  const clip = {
    x,
    y,
    width: Math.min(viewport.width - x, region.width + pad.x * 2),
    height: Math.min(viewport.height - y, region.height + pad.y * 2),
  };
  const file = path.join(OUTPUT_DIR, `${slug}${TAG}.png`);
  await page.screenshot({ path: file, clip, type: "png", animations: "disabled", caret: "hide" });
  written.add(`${slug}${TAG}.png`);
}

const row = (page: Page, branch: string): Locator => page.locator(SEL.worktree.row(branch)).first();
const card = (page: Page, branch: string): Locator =>
  page.locator(SEL.worktree.card(branch)).first();

/** The environment trigger: the popover button, or the bare tooltip icon when there is nothing to open. */
const envTrigger = (page: Page, branch: string): Locator =>
  row(page, branch).locator('button[aria-label*=" environment"]').first();

const openPopover = (page: Page): Locator =>
  page.locator('[data-radix-popper-content-wrapper] [role="dialog"]').first();

async function worktreeId(page: Page, branch: string): Promise<string> {
  const id = await page.evaluate(async (b) => {
    const all = await window.electron.worktree.getAll();
    return all.find((w) => w.branch === b)?.id ?? null;
  }, branch);
  if (!id) throw new Error(`no worktree for ${branch}`);
  return id;
}

async function dispatch(page: Page, actionId: string, args: unknown): Promise<void> {
  await page.evaluate(
    async ([a, payload]) => {
      await window.__daintreeDispatchAction(a, payload, { source: "test" });
    },
    [actionId, args] as const
  );
}

/** Run a real status check and wait until the card reports the scenario's status. */
async function checkStatus(page: Page, branch: string, expected: string): Promise<void> {
  const id = await worktreeId(page, branch);
  await dispatch(page, "worktree.resource.status", { worktreeId: id });
  await expect
    .poll(() => card(page, branch).getAttribute("data-resource-status"), {
      timeout: T_LONG,
      message: `${branch} never reported status ${expected}`,
    })
    .toBe(expected);
}

async function closePopover(page: Page): Promise<void> {
  const pop = openPopover(page);
  if (await pop.isVisible().catch(() => false)) {
    await page.keyboard.press("Escape");
    if (await pop.isVisible({ timeout: 1500 }).catch(() => false)) {
      // Focus drifted out of the content; hand Escape to the popover itself.
      await pop.press("Escape");
    }
    await expect(pop).toBeHidden({ timeout: T_LONG });
  }
  // A keyboard close restores a ringed focus to the trigger, which would show
  // up in the next trigger shot as a state that is not the one being captured.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.mouse.move(1600, 1000);
}

/** Open the popover by pointer and prove it carries the text that makes this state this state. */
async function openByClick(
  page: Page,
  branch: string,
  expectText: string | RegExp
): Promise<Locator> {
  await closePopover(page);
  await envTrigger(page, branch).click();
  const pop = openPopover(page);
  await expect(pop, "popover never opened").toBeVisible({ timeout: T_LONG });
  await expect(pop, `popover is missing ${String(expectText)}`).toContainText(expectText, {
    timeout: T_LONG,
  });
  // Park the pointer away so the capture is not a hover state of the trigger.
  await page.mouse.move(1600, 1000);
  return pop;
}

test("worktree environment popover review — states and themes", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_ENV is required for the environment popover capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_ENV to run the environment popover capture");
  test.setTimeout(15 * 60_000);

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const repo = createFixtureRepo();
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-envshot-"));
  let ctx: AppContext | undefined;

  try {
    ctx = await launchApp({
      userDataDir,
      screenshotScale: SCALE,
      windowSize: { width: 1680, height: 1050 },
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
    });
    const page = await openAndOnboardProject(ctx.app, ctx.window, repo.dir, "Helios Inference");
    await dismissBlockingPalette(page);

    for (const wt of Object.values(WORKTREES)) {
      await expect(row(page, wt.branch), `card ${wt.branch} never rendered`).toBeVisible({
        timeout: T_LONG,
      });
    }

    // Icons live in project settings; the environments themselves in config.json.
    await saveCurrentProjectSettings(page, {
      resourceEnvironments: { [ENV_GPU]: { icon: "Cpu" }, [ENV_BARE]: {} },
    });

    setScenario(repo, WORKTREES.gpu.slug, SCENARIOS.ready);
    setScenario(repo, WORKTREES.local.slug, SCENARIOS.ready);
    for (const [wt, env] of [
      [WORKTREES.gpu, ENV_GPU],
      [WORKTREES.bare, ENV_BARE],
    ] as const) {
      const id = await worktreeId(page, wt.branch);
      await page.evaluate(
        async ([worktreeId, envKey]) => {
          await window.electron.worktreePort.request("switch-worktree-environment", {
            worktreeId,
            envKey,
          });
        },
        [id, env] as const
      );
    }
    for (const wt of Object.values(WORKTREES)) {
      await approveWorktreeCommands(page, wt.branch);
    }
    await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
    await settle(page, 1200);

    const gpu = WORKTREES.gpu.branch;

    // 1. Each status, twice: the trigger at rest in its header (does the icon
    //    warn before anyone opens anything?) and the popover it opens.
    const statusStates: Array<[string, keyof typeof SCENARIOS, string]> = [
      ["10-ready", "ready", "ready"],
      ["20-provisioning", "provisioning", "provisioning"],
      ["30-unhealthy-long-log", "unhealthy", "unhealthy"],
      ["40-paused", "paused", "paused"],
      ["50-degraded-long-endpoint", "degraded", "degraded"],
      ["60-minimal-fields", "minimal", "ready"],
    ];
    for (const [slug, scenario, status] of statusStates) {
      await step(slug.replace(/^\d+-/, ""), async () => {
        await closePopover(page);
        setScenario(repo, WORKTREES.gpu.slug, SCENARIOS[scenario]);
        await checkStatus(page, gpu, status);
        await snapRegion(page, `${slug}-trigger`, [envTrigger(page, gpu)], { x: 150, y: 16 });
        const pop = await openByClick(page, gpu, status);
        await snapRegion(page, `${slug}-popover`, [envTrigger(page, gpu), pop]);
        await closePopover(page);
      });
    }

    // 2. Lifecycle running: a real provision that takes its time. The card
    //    synthesises "provisioning" from the phase and pulses the icon.
    await step("lifecycle", async () => {
      await closePopover(page);
      // Provision is a no-op on a ready status and becomes a resume on a paused
      // one, so start from a failed check.
      setScenario(repo, WORKTREES.gpu.slug, SCENARIOS.unhealthy);
      await checkStatus(page, gpu, "unhealthy");
      writeFileSync(path.join(repo.scenarioDir, `${WORKTREES.gpu.slug}.provision-ms`), "90000");
      const id = await worktreeId(page, gpu);
      void dispatch(page, "worktree.resource.provision", { worktreeId: id });
      await expect
        .poll(() => card(page, gpu).getAttribute("data-resource-status"), { timeout: T_LONG })
        .toMatch(/^(provisioning|starting)$/);
      await snapRegion(page, "70-lifecycle-running-trigger", [envTrigger(page, gpu)], {
        x: 150,
        y: 16,
      });
      const pop = await openByClick(page, gpu, /Provisioning|Resuming/);
      await snapRegion(page, "71-lifecycle-running-popover", [envTrigger(page, gpu), pop]);
      await closePopover(page);
    });

    // 3. Local mode with a status from the repo's default resource block: first
    //    before anything has checked it, then with a result.
    await step("local", async () => {
      await closePopover(page);
      if (!(await card(page, WORKTREES.local.branch).getAttribute("data-resource-status"))) {
        const unchecked = await openByClick(page, WORKTREES.local.branch, "Not checked yet");
        await snapRegion(page, "79-local-unchecked-popover", [
          envTrigger(page, WORKTREES.local.branch),
          unchecked,
        ]);
        await closePopover(page);
      }
      await checkStatus(page, WORKTREES.local.branch, "ready");
      const pop = await openByClick(page, WORKTREES.local.branch, "ready");
      await snapRegion(page, "80-local-mode-popover", [
        envTrigger(page, WORKTREES.local.branch),
        pop,
      ]);
      await closePopover(page);
    });

    // 4. The sparse environment: no icon chosen, no status command. It still
    //    opens, so its name is reachable, and it says what would fill it.
    await step("bare", async () => {
      await closePopover(page);
      const trigger = envTrigger(page, WORKTREES.bare.branch);
      await snapRegion(page, "85-bare-env-trigger", [trigger], { x: 150, y: 16 });
      const pop = await openByClick(page, WORKTREES.bare.branch, ENV_BARE);
      await snapRegion(page, "86-bare-env-popover", [trigger, pop]);
      await closePopover(page);
    });

    // 5. Keyboard: Tab to the trigger (a real :focus-visible, not a scripted
    //    focus), open with Enter, Tab to the action. Then press it and shoot the
    //    frame right after, which is all the feedback a refresh gets.
    await step("keyboard", async () => {
      await closePopover(page);
      setScenario(repo, WORKTREES.gpu.slug, SCENARIOS.ready);
      await checkStatus(page, gpu, "ready");
      const trigger = envTrigger(page, gpu);
      await page.locator(SEL.worktree.searchInput).first().click();
      let reached = false;
      for (let i = 0; i < 80 && !reached; i++) {
        await page.keyboard.press("Tab");
        reached = await trigger
          .evaluate((el) => el === document.activeElement && el.matches(":focus-visible"))
          .catch(() => false);
      }
      if (!reached)
        throw new Error("never reached :focus-visible on the environment trigger by Tab");
      await snapRegion(page, "90-trigger-keyboard-focus", [trigger], { x: 150, y: 16 });
      await page.keyboard.press("Enter");
      const pop = openPopover(page);
      await expect(pop).toBeVisible({ timeout: T_LONG });
      await snapRegion(page, "91-popover-opened-by-keyboard", [trigger, pop]);
      const action = pop.getByRole("button").last();
      for (let i = 0; i < 6; i++) {
        const onAction = await action
          .evaluate((el) => el === document.activeElement)
          .catch(() => false);
        if (onAction) break;
        await page.keyboard.press("Tab");
      }
      await expect(action, "keyboard never reached the popover action").toBeFocused();
      await snapRegion(page, "92-popover-action-focus", [trigger, pop]);
      setScenario(repo, WORKTREES.gpu.slug, SCENARIOS.paused);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(120);
      await snapRegion(page, "93-popover-after-check", [trigger, pop], { x: 24, y: 20 });
      // Once the result lands: the settled footer, with its completion cue.
      await expect(pop).toContainText("paused", { timeout: T_LONG });
      await snapRegion(page, "94-popover-check-landed", [trigger, pop], { x: 24, y: 20 });
      await page.keyboard.press("Escape");
      await expect(pop).toBeHidden({ timeout: T_LONG });
      await expect(trigger, "Escape did not return focus to the trigger").toBeFocused();
    });

    // 6. High contrast, on the richest red state.
    await step("contrast", async () => {
      await closePopover(page);
      setScenario(repo, WORKTREES.gpu.slug, SCENARIOS.unhealthy);
      await checkStatus(page, gpu, "unhealthy");
      await page.emulateMedia({ contrast: "more" });
      let pop = await openByClick(page, gpu, "unhealthy");
      await snapRegion(page, "95-prefers-contrast", [envTrigger(page, gpu), pop]);
      await closePopover(page);
      await page.emulateMedia({ contrast: "no-preference", forcedColors: "active" });
      pop = await openByClick(page, gpu, "unhealthy");
      await snapRegion(page, "96-forced-colors", [envTrigger(page, gpu), pop]);
      await closePopover(page);
      await page.emulateMedia({ forcedColors: "none" });
    });

    // 7. Theme sweep of the red, long-output state — status colour and the log
    //    well are where themes collapse.
    await step("themes", async () => {
      await closePopover(page);
      setScenario(repo, WORKTREES.gpu.slug, SCENARIOS.unhealthy);
      const themes = SWEEP_THEMES.length > 0 ? SWEEP_THEMES : ALL_THEMES;
      for (const theme of themes) {
        await setAppTheme(page, theme);
        await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
        await dismissBlockingPalette(page);
        await expect(row(page, gpu)).toBeVisible({ timeout: T_LONG });
        await checkStatus(page, gpu, "unhealthy");
        const pop = await openByClick(page, gpu, "unhealthy");
        await snapRegion(page, `200-theme-${theme}`, [envTrigger(page, gpu), pop]);
        await closePopover(page);
      }
    });
  } finally {
    if (ctx?.app) await closeApp(ctx.app);
    repo.cleanup();
    rmSync(userDataDir, { recursive: true, force: true });
  }

  const onDisk = readdirSync(OUTPUT_DIR).filter((f) => f.endsWith(`${TAG}.png`));
  console.log(`[env-shots] wrote ${written.size} shots; ${onDisk.length} PNGs on disk`);
  if (written.size === 0) throw new Error("[env-shots] produced no screenshots at all");
  if (stepFailures.length > 0) {
    throw new Error(
      `[env-shots] ${stepFailures.length} step(s) failed:\n${stepFailures.join("\n")}`
    );
  }
});
