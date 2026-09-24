/**
 * Agent shortcut recorder visual-review harness.
 *
 * `AgentShortcutCapture` is the recorder that binds a launch shortcut to a built-in
 * agent. It lives in two hosts — the Keyboard shortcut row on an agent's settings
 * page, and the compact in-place row inside the launcher — and nearly all of its
 * design weight sits in transient states: armed and waiting, modifiers held, a combo
 * captured that is fine, one that breaks the agent-shortcut rule, one that collides
 * with another action, and one that is already the current binding. This harness
 * drives each of them through the shipping UI with real keystrokes, in a dark and a
 * light theme in one launch.
 *
 *   DAINTREE_SHOT_AGENT_SHORTCUT=1 DAINTREE_SHOT_DIR=/abs/out \
 *     npx playwright test --project=screenshots agent-shortcut-capture-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_AGENT_SHORTCUT  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR             required — output directory (never the repo)
 *   DAINTREE_SHOT_THEMES          comma-separated theme ids (default `,bondi`; empty = app default)
 *
 * A manifest.json beside the PNGs lists every state written, and the run fails unless
 * the files on disk match it and every planned state landed.
 */

import { test, expect, type Page, type ElectronApplication } from "@playwright/test";
import { execSync } from "child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { setAppTheme } from "../helpers/theme";
import { injectStub } from "../helpers/ipcFaults";
import { SEL } from "../helpers/selectors";
import { T_LONG } from "../helpers/timeouts";

const ENABLED = !!process.env.DAINTREE_SHOT_AGENT_SHORTCUT;
const OUTPUT_DIR = process.env.DAINTREE_SHOT_DIR ? path.resolve(process.env.DAINTREE_SHOT_DIR) : "";
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? ",bondi").split(",");

const DIALOG = '[role="dialog"]:has(.settings-sidebar)';
const CLOSE = '[aria-label="Close settings"]';
const navItem = (tab: string) => `.settings-sidebar [role="tab"][data-tab="${tab}"]`;
const CAPTURE = '[data-testid="shortcut-capture"]';

const DOCK_TRIGGER = '[aria-label="Open launcher"]';
const SEARCH_BOX = '[aria-label="Search agents, panels, and recipes"]';
const OPTION = '[role="option"]';

const PROJECT_NAME = "Helios Dashboard";
const WIDE = { width: 1680, height: 1050 };
// Longer than the recorder's chord window, so a single stroke has settled into its
// captured state before the shot.
const CHORD_SETTLE_MS = 1400;

const AVAILABILITY: Record<string, string> = { claude: "ready", gemini: "ready", codex: "ready" };

// Gemini starts unbound so its row shows the empty state; Codex keeps Cmd+Alt+X,
// which is the collision the conflict state records.
const OVERRIDES: { actionId: string; combo: string[] }[] = [
  { actionId: "agent.gemini", combo: [] },
];

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

function createFixtureRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "daintree-agentshortcut-shots-"));
  git("init -b main", dir);
  git('config user.email "test@daintree.dev"', dir);
  git('config user.name "Daintree Test"', dir);
  writeFileSync(path.join(dir, "README.md"), "# Helios Dashboard\n");
  git("add -A", dir);
  git('commit -m "initial commit"', dir);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function settle(page: Page, ms = 350): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

async function setWindowSize(
  app: ElectronApplication,
  size: { width: number; height: number }
): Promise<void> {
  await app.evaluate(({ BrowserWindow }, s) => {
    BrowserWindow.getAllWindows()[0]?.setSize(s.width, s.height);
  }, size);
}

interface ManifestEntry {
  file: string;
  state: string;
  theme: string;
}

const manifest: ManifestEntry[] = [];
const failures: string[] = [];
const planned: string[] = [];

/**
 * Clip to the element plus a margin, so the shot carries the host around the
 * recorder — the row label beside it, the launcher rows above and below — which is
 * what the recorder has to read against. Throws when the file did not land.
 */
async function snap(page: Page, state: string, theme: string, selector: string, pad = 28) {
  await settle(page, 250);
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`no bounding box for ${selector}`);
  const viewport = page.viewportSize() ?? WIDE;
  const x = Math.max(0, box.x - pad);
  const y = Math.max(0, box.y - pad);
  const file = `${state}--${theme || "default"}.png`;
  const out = path.join(OUTPUT_DIR, file);
  await page.screenshot({
    path: out,
    type: "png",
    animations: "disabled",
    caret: "hide",
    clip: {
      x,
      y,
      width: Math.min(box.width + pad * 2, viewport.width - x),
      height: Math.min(box.height + pad * 2, viewport.height - y),
    },
  });
  if (!existsSync(out)) throw new Error(`screenshot did not land at ${out}`);
  manifest.push({ file, state, theme: theme || "default" });
}

async function step(page: Page, name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    failures.push(`${name}: ${String(error).split("\n")[0]!.slice(0, 400)}`);
    await page.keyboard.press("Escape").catch(() => {});
    await dismissBlockingPalette(page).catch(() => {});
  }
}

async function openAgentSettings(page: Page, subtab: string): Promise<void> {
  await closeSettings(page);
  await page.evaluate(
    (detail) => {
      window.dispatchEvent(new CustomEvent("daintree:open-settings-tab", { detail }));
    },
    { tab: "agents", subtab }
  );
  await page.locator(DIALOG).waitFor({ state: "visible", timeout: 20_000 });
  await expect(page.locator(navItem("agents"))).toHaveAttribute("aria-selected", "true", {
    timeout: 15_000,
  });
  const row = page.locator(`#agents-shortcut-${subtab}`);
  await row.waitFor({ state: "visible", timeout: 15_000 });
  await row.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await page.mouse.move(2, 2);
  await settle(page, 500);
}

async function closeSettings(page: Page): Promise<void> {
  if (
    !(await page
      .locator(DIALOG)
      .isVisible()
      .catch(() => false))
  )
    return;
  await page
    .locator(CLOSE)
    .click({ timeout: 3000 })
    .catch(() => {});
  await page
    .locator(DIALOG)
    .waitFor({ state: "hidden", timeout: 8000 })
    .catch(() => {});
}

/** Arm the recorder if it is not armed already — a host may open it armed or idle. */
async function arm(page: Page, scope: string): Promise<void> {
  const field = page.locator(`${scope} [data-testid="shortcut-capture-field"]`).first();
  if ((await field.getAttribute("data-recording")) === "true") return;
  const again = page.locator(scope).getByRole("button", { name: /record again/i });
  if (await again.isVisible().catch(() => false)) await again.click();
  else await field.click();
  await expect(field).toHaveAttribute("data-recording", "true", { timeout: 3000 });
}

async function press(page: Page, combo: string): Promise<void> {
  await page.keyboard.press(combo);
  await page.waitForTimeout(CHORD_SETTLE_MS);
  await settle(page, 200);
}

async function captureSettings(page: Page, theme: string): Promise<void> {
  const row = "#agents-shortcut-claude";

  await step(page, "settings-rest", async () => {
    planned.push("s01-row-bound", "s02-row-unbound");
    await openAgentSettings(page, "claude");
    await snap(page, "s01-row-bound", theme, row);
    await openAgentSettings(page, "gemini");
    await snap(page, "s02-row-unbound", theme, "#agents-shortcut-gemini");
  });

  await step(page, "settings-edit", async () => {
    planned.push(
      "s03-edit-opened",
      "s04-recording",
      "s05-modifiers-held",
      "s06-captured-valid",
      "s07-captured-invalid",
      "s08-captured-conflict",
      "s09-captured-current"
    );
    await openAgentSettings(page, "claude");
    await page.locator('[data-testid="agent-shortcut-edit-claude"]').click();
    await page.locator(`${row} ${CAPTURE}`).waitFor({ state: "visible", timeout: 5000 });
    await page.mouse.move(2, 2);
    await snap(page, "s03-edit-opened", theme, row);

    await arm(page, row);
    await page.mouse.move(2, 2);
    await snap(page, "s04-recording", theme, row);

    await page.keyboard.down("Meta");
    await page.keyboard.down("Alt");
    await settle(page, 300);
    await snap(page, "s05-modifiers-held", theme, row);
    await page.keyboard.up("Alt");
    await page.keyboard.up("Meta");
    await settle(page, 200);

    await arm(page, row);
    await press(page, "Meta+Alt+KeyY");
    await expect(page.locator(row).getByRole("button", { name: "Save" })).toBeEnabled();
    await snap(page, "s06-captured-valid", theme, row);

    await arm(page, row);
    await press(page, "Meta+Shift+KeyY");
    await expect(
      page.locator(`${row} [data-testid="shortcut-capture-validation-error"]`)
    ).toBeVisible();
    await snap(page, "s07-captured-invalid", theme, row);

    await arm(page, row);
    await press(page, "Meta+Alt+KeyX");
    await expect(page.locator(`${row} [data-testid="shortcut-capture-conflicts"]`)).toBeVisible();
    await snap(page, "s08-captured-conflict", theme, row);

    await arm(page, row);
    await press(page, "Meta+Alt+KeyC");
    await snap(page, "s09-captured-current", theme, row);

    await page.locator(row).getByRole("button", { name: "Cancel", exact: true }).click();
    await settle(page, 200);
  });

  await closeSettings(page);
}

let dockReady = false;
async function ensureDock(page: Page): Promise<void> {
  if (dockReady) return;
  await page.locator(SEL.toolbar.openTerminal).click();
  await page.locator(SEL.panel.gridPanel).first().waitFor({ state: "visible", timeout: T_LONG });
  await settle(page, 1500);
  const minimize = page.locator(SEL.panel.minimize).first();
  await minimize.waitFor({ state: "visible", timeout: 5000 });
  await minimize.click();
  await settle(page, 1000);
  dockReady = true;
}

async function closeLauncher(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    if (
      !(await page
        .locator(SEARCH_BOX)
        .isVisible()
        .catch(() => false))
    )
      return;
    await page.keyboard.press("Escape").catch(() => {});
    await settle(page, 200);
  }
}

/** Open the launcher and put the Claude row into its in-place recorder. */
async function openTrayCapture(page: Page): Promise<string> {
  await closeLauncher(page);
  await page.locator(DOCK_TRIGGER).first().click({ timeout: 10_000 });
  await page.locator(SEARCH_BOX).waitFor({ state: "visible", timeout: 8000 });
  await expect.poll(() => page.locator(OPTION).count(), { timeout: 10_000 }).toBeGreaterThan(3);
  await settle(page, 300);
  const edit = page.locator('[data-testid="launcher-shortcut-edit-claude"]').first();
  await edit.waitFor({ state: "attached", timeout: 5000 });
  await edit.click({ force: true });
  const scope = '[data-testid="launcher-capture-claude"]';
  await page.locator(scope).waitFor({ state: "visible", timeout: 5000 });
  await page.mouse.move(2, 2);
  return scope;
}

async function captureTray(page: Page, theme: string): Promise<void> {
  await step(page, "tray", async () => {
    planned.push(
      "t01-armed",
      "t02-captured-valid",
      "t03-captured-invalid",
      "t04-captured-conflict"
    );
    await ensureDock(page);

    let scope = await openTrayCapture(page);
    await snap(page, "t01-armed", theme, scope, 44);

    await arm(page, scope);
    await press(page, "Meta+Alt+KeyY");
    await snap(page, "t02-captured-valid", theme, scope, 44);

    scope = await openTrayCapture(page);
    await arm(page, scope);
    await press(page, "Meta+Shift+KeyY");
    await expect(
      page.locator(`${scope} [data-testid="shortcut-capture-validation-error"]`)
    ).toBeVisible();
    await snap(page, "t03-captured-invalid", theme, scope, 44);

    scope = await openTrayCapture(page);
    await arm(page, scope);
    await press(page, "Meta+Alt+KeyX");
    await expect(page.locator(`${scope} [data-testid="shortcut-capture-conflicts"]`)).toBeVisible();
    await snap(page, "t04-captured-conflict", theme, scope, 44);
  });
  await closeLauncher(page);
}

test("agent shortcut recorder — every state in both hosts", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_AGENT_SHORTCUT is required for the agent shortcut capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_AGENT_SHORTCUT to run the agent shortcut capture");
  if (!OUTPUT_DIR) throw new Error("DAINTREE_SHOT_DIR is required — captures never go in the repo");
  test.setTimeout(15 * 60_000);

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const repo = createFixtureRepo();
  // Prefix deliberately avoids "daintree-e2e": launchApp's pre-launch hygiene pkills it.
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-agentshortcutshot-"));
  let ctx: AppContext | undefined;
  const themeNames: string[] = [];

  try {
    ctx = await launchApp({
      userDataDir,
      windowSize: WIDE,
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
      env: { DAINTREE_E2E_FAULT_MODE: "1" },
    });
    await setWindowSize(ctx.app, WIDE);
    await injectStub(ctx.app, "system:get-cli-availability", AVAILABILITY);
    await injectStub(ctx.app, "system:refresh-cli-availability", AVAILABILITY);

    const page = await openAndOnboardProject(ctx.app, ctx.window, repo.dir, PROJECT_NAME);
    for (const override of OVERRIDES) {
      const result = await page.evaluate(
        (o) =>
          window.__daintreeDispatchAction?.("keybinding.setOverride", o, { source: "user" }) ??
          Promise.resolve({ ok: false }),
        override
      );
      if (!(result as { ok: boolean }).ok)
        throw new Error(`could not seed override ${override.actionId}`);
    }

    for (const theme of THEMES) {
      themeNames.push(theme || "default");
      if (theme) await setAppTheme(page, theme);
      else await page.reload({ waitUntil: "domcontentloaded" });
      await page.addStyleTag({ content: POLISH_CSS });
      await dismissBlockingPalette(page);
      await settle(page, 800);
      dockReady = false;
      await captureSettings(page, theme);
      await captureTray(page, theme);
    }
  } finally {
    if (ctx) await closeApp(ctx.app).catch(() => {});
    repo.cleanup();
    rmSync(userDataDir, { recursive: true, force: true });
  }

  writeFileSync(path.join(OUTPUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2));
  const onDisk = new Set(readdirSync(OUTPUT_DIR).filter((f) => f.endsWith(".png")));
  const missingOnDisk = manifest.filter((m) => !onDisk.has(m.file)).map((m) => m.file);
  const landed = new Set(manifest.map((m) => `${m.state}--${m.theme}`));
  const unlanded = [...new Set(planned)].filter(
    (state) => !themeNames.every((t) => landed.has(`${state}--${t}`))
  );
  console.log(`[agent-shortcut-shots] ${manifest.length} PNGs → ${OUTPUT_DIR}`);
  if (missingOnDisk.length > 0) failures.push(`missing on disk: ${missingOnDisk.join(", ")}`);
  if (unlanded.length > 0) failures.push(`planned but never shot: ${unlanded.join(", ")}`);
  if (failures.length > 0)
    throw new Error(`agent shortcut capture failed:\n  ${failures.join("\n  ")}`);
  expect(manifest.length).toBe(13 * THEMES.length);
});
