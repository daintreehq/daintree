/**
 * Floating-surface elevation visual-review harness.
 *
 * Everything that floats over the workbench — toasts, the re-entry summary,
 * the terminal find bar and scroll pill, the artifact overlay, the getting-
 * started checklist, the side sheets (theme browser, Portal, assistant), a
 * canonical popover, the toolbar-settings drag overlay and a settings
 * choicebox — is meant to share one elevation vocabulary: radius, border,
 * background and shadow. The only honest review lays them side by side, in a
 * dark and a light theme, with enough of the app around each one that the
 * shadow halo is visible on the content it falls on. Side sheets are shot as
 * the full window so their leading-edge shadow over the workspace shows.
 *
 * One launch drives the real app; each theme is applied through the real
 * app-theme IPC (`setAppTheme`, which reloads the view) and every surface is
 * reached the way the app reaches it — an action dispatch, a keybinding, the
 * event a menu fires, or the IPC event main would send. Each state is verified
 * painted (its text or element is on screen with a real box) before its PNG is
 * written; a state that cannot be verified throws instead of writing.
 *
 * Steps (each also the DAINTREE_SHOT_ONLY filter name):
 *
 *   toast        three toasts, one with two actions
 *   reentry      the "While you were away" summary card
 *   findbar      the terminal find bar with a query
 *   scrollpill   the terminal "New output below" pill
 *   artifact     the artifact overlay expanded over a terminal
 *   checklist    the getting-started checklist
 *   themebrowser the theme browser side sheet (full window)
 *   portal       the Portal dock side sheet (full window)
 *   assistant    the assistant (help) panel (full window)
 *   popover      the notification center popover, the canonical popover reference
 *   toolbardrag  Settings → Toolbar mid-drag of a button (the drag overlay)
 *   choicebox    Settings → Assistant "Tool set" choicebox with a selected card
 *
 * Opt-in only: skips itself unless DAINTREE_SHOT_FLOATING is set. Needs a
 * current `npm run build:e2e` bundle.
 *
 *   DAINTREE_SHOT_FLOATING=1 DESIGN_CAPTURE_DIR=/tmp/floating \
 *     npx playwright test --project=screenshots floating-elevation-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_FLOATING     required — any truthy value runs the capture
 *   DAINTREE_SHOT_ONLY         comma-separated step filter (see step names above)
 *   DESIGN_CAPTURE_DIR         optional output dir, so review rounds write outside the tree
 *   DAINTREE_SCREENSHOT_SCALE  device scale factor (default 2)
 *
 * Output: <dir>/<NN-surface>-<dark|light>.png (default artifacts/floating-elevation-shots, gitignored).
 */

import { test, expect, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { execSync } from "child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { setAppTheme } from "../helpers/theme";
import {
  injectToast,
  resetNotifications,
  seedNotificationHistory,
  type InjectToastOptions,
} from "../helpers/notifications";
import { runTerminalCommand, waitForTerminalText } from "../helpers/terminal";
import { SEL } from "../helpers/selectors";
import { T_LONG } from "../helpers/timeouts";

const ENABLED = !!process.env.DAINTREE_SHOT_FLOATING;
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";
const ONLY = (process.env.DAINTREE_SHOT_ONLY ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const OUTPUT_DIR = process.env.DESIGN_CAPTURE_DIR
  ? path.resolve(process.env.DESIGN_CAPTURE_DIR)
  : path.resolve(process.cwd(), "artifacts", "floating-elevation-shots");

interface Theme {
  id: string;
  name: string;
  mode: "dark" | "light";
}

const THEMES: Theme[] = [
  { id: "daintree", name: "Daintree", mode: "dark" },
  { id: "svalbard", name: "Svalbard", mode: "light" },
];

/** Margin of app kept around a floating surface so its shadow halo is in frame. */
const HALO = 64;

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

const SETTINGS_DIALOG = '[role="dialog"]:has(.settings-sidebar)';
const ASSISTANT_PANEL = 'aside[aria-label="Daintree Assistant"]';
const DRAG_OVERLAY = '[class*="shadow-"][class*="cursor-grabbing"]';

type Fixture = InjectToastOptions & { expect: string };

const TOASTS: Fixture[] = [
  {
    type: "info",
    title: "Update available",
    message: "Daintree 0.42.0 is downloading in the background.",
    expect: "is downloading in the background",
  },
  {
    type: "success",
    title: "Claude finished",
    message: "Refactored the checkout form in helios-dashboard/feature-checkout.",
    actions: [
      { label: "Open review", variant: "primary" },
      { label: "Show terminal", variant: "secondary" },
    ],
    context: { projectId: "e2e-project", eventKind: "completed" },
    expect: "Refactored the checkout form",
  },
  {
    type: "error",
    title: "Push failed",
    message:
      "The remote rejected feature/checkout-redesign because it has commits you don't have. Pull first, then push again.",
    actions: [{ label: "Pull and rebase", variant: "primary" }],
    context: { projectId: "e2e-project", eventKind: "git" },
    expect: "The remote rejected",
  },
];

const PATCH = `diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1 +1,3 @@
 # Helios Dashboard
+
+Checkout redesign: one-page flow with inline card validation.
`;

const failures: string[] = [];

interface DispatchResult {
  ok?: boolean;
  result?: {
    terminalId?: string;
    worktrees?: Array<{ id: string; isMain?: boolean }>;
  };
  error?: { message?: string };
}

async function dispatchAction(
  page: Page,
  actionId: string,
  args?: unknown
): Promise<DispatchResult> {
  return page.evaluate(
    ([id, a]) =>
      (
        window as unknown as {
          __daintreeDispatchAction: (id: string, a?: unknown) => Promise<DispatchResult>;
        }
      ).__daintreeDispatchAction(id, a),
    [actionId, args] as const
  );
}

async function settle(page: Page, ms = 400): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

async function parkPointer(page: Page): Promise<void> {
  await page.mouse.move(2, 400);
}

async function blur(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

type Box = { x: number; y: number; width: number; height: number };

async function realBox(target: Locator, what: string, min = 8): Promise<Box> {
  const box = await target.boundingBox();
  if (!box || box.width < min || box.height < min) {
    throw new Error(`${what}: no real box (${JSON.stringify(box)}) — refusing to write`);
  }
  return box;
}

/** Throws unless the target is at least 200px wide and painted inside the window. */
async function expectOnScreen(page: Page, target: Locator, what: string): Promise<void> {
  const box = await realBox(target, what, 200);
  const view = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
  if (box.x < -1 || box.x + box.width > view.w + 1) {
    throw new Error(`${what}: box ${JSON.stringify(box)} is outside the ${view.w}px window`);
  }
  const hit = await target.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return !!at && el.contains(at);
  });
  if (!hit) throw new Error(`${what}: its centre is covered by another layer`);
}

/** Union of the targets' boxes plus the halo margin, clamped to the window. */
async function snap(
  page: Page,
  file: string,
  targets: Locator[],
  opts: { pad?: number; within?: Box } = {}
): Promise<void> {
  await settle(page);
  const boxes: Box[] = [];
  for (const target of targets) boxes.push(await realBox(target, file));
  const pad = opts.pad ?? HALO;
  const view = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
  const bound = opts.within ?? { x: 0, y: 0, width: view.w, height: view.h };
  const left = Math.max(bound.x, 0, Math.min(...boxes.map((b) => b.x)) - pad);
  const top = Math.max(bound.y, 0, Math.min(...boxes.map((b) => b.y)) - pad);
  const right = Math.min(
    bound.x + bound.width,
    view.w,
    Math.max(...boxes.map((b) => b.x + b.width)) + pad
  );
  const bottom = Math.min(
    bound.y + bound.height,
    view.h,
    Math.max(...boxes.map((b) => b.y + b.height)) + pad
  );
  await page.screenshot({
    path: path.join(OUTPUT_DIR, `${file}.png`),
    type: "png",
    animations: "disabled",
    caret: "hide",
    clip: { x: left, y: top, width: right - left, height: bottom - top },
  });
}

async function snapWindow(page: Page, file: string): Promise<void> {
  await settle(page);
  await page.screenshot({
    path: path.join(OUTPUT_DIR, `${file}.png`),
    type: "png",
    animations: "disabled",
    caret: "hide",
  });
}

/** Steps that open their own terminal; every other step shoots over a backdrop terminal. */
const OWN_TERMINAL = new Set(["findbar", "scrollpill", "artifact"]);

async function step(
  page: Page,
  name: string,
  mode: string,
  fn: () => Promise<void>
): Promise<void> {
  if (ONLY.length > 0 && !ONLY.includes(name)) return;
  try {
    if (!OWN_TERMINAL.has(name)) await ensureBackdropTerminal(page);
    await fn();
  } catch (error) {
    const detail = String(error).split("\n").slice(0, 3).join(" ").slice(0, 400);
    console.warn(`[floating-shots] step "${name}" (${mode}) failed:`, detail);
    failures.push(`${name}-${mode}: ${detail}`);
  } finally {
    await page.keyboard.press("Escape").catch(() => {});
    await parkPointer(page).catch(() => {});
    await dismissBlockingPalette(page).catch(() => {});
  }
}

/** Opens a terminal alone in the grid, so the pane is full width, and waits for the seed output. */
async function newTerminal(page: Page, seed: string, expectText: string): Promise<Locator> {
  const existing = await page
    .locator(SEL.panel.gridPanel)
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-panel-id")));
  for (const id of existing) {
    if (id) await closeTerminal(page, page.locator(`[data-panel-id="${id}"]`).first());
  }
  const created = await dispatchAction(page, "terminal.new");
  const panelId = created.result?.terminalId;
  if (!panelId) throw new Error(`terminal.new gave no terminal: ${created.error?.message ?? "?"}`);
  const panel = page.locator(`[data-panel-id="${panelId}"]`).first();
  await panel.waitFor({ state: "visible", timeout: T_LONG });
  await runTerminalCommand(page, panel, seed, { readyTimeout: 45_000 });
  await waitForTerminalText(panel, expectText, 45_000);
  await settle(page, 600);
  return panel;
}

async function closeTerminal(page: Page, panel: Locator | undefined): Promise<void> {
  if (!panel) return;
  const panelId = await panel.getAttribute("data-panel-id").catch(() => null);
  if (!panelId) return;
  await dispatchAction(page, "terminal.close", { terminalId: panelId }).catch(() => {});
  await page
    .locator(`[data-panel-id="${panelId}"]`)
    .waitFor({ state: "detached", timeout: 8000 })
    .catch(() => {});
  await settle(page, 300);
}

async function mainWorktreeId(page: Page): Promise<string> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const listed = await dispatchAction(page, "worktree.list");
    const id = (listed.result?.worktrees ?? []).find((w) => w.isMain)?.id;
    if (id !== undefined) return id;
    await page.waitForTimeout(250);
  }
  throw new Error("main worktree never resolved");
}

async function openSettingsAt(page: Page, tab: string): Promise<Locator> {
  await page.evaluate(
    (detail) => window.dispatchEvent(new CustomEvent("daintree:open-settings-tab", { detail })),
    { tab }
  );
  const dialog = page.locator(SETTINGS_DIALOG);
  await dialog.waitFor({ state: "visible", timeout: 20_000 });
  await expect(page.locator(`.settings-sidebar [role="tab"][data-tab="${tab}"]`)).toHaveAttribute(
    "aria-selected",
    "true",
    { timeout: 15_000 }
  );
  await settle(page, 1000);
  return dialog;
}

async function closeSettings(page: Page): Promise<void> {
  const dialog = page.locator(SETTINGS_DIALOG);
  if (!(await dialog.isVisible().catch(() => false))) return;
  await page
    .locator(SEL.settings.closeButton)
    .click({ timeout: 3000 })
    .catch(() => {});
  await dialog.waitFor({ state: "hidden", timeout: 8000 }).catch(() => {});
  await settle(page, 300);
}

/** A terminal in the grid gives the side sheets real content to cast their shadow onto. */
async function ensureBackdropTerminal(page: Page): Promise<void> {
  if ((await page.locator(SEL.panel.gridPanel).count()) > 0) return;
  await newTerminal(
    page,
    "printf 'helios-dashboard: 42 files, 0 errors\\nready on http://localhost:5173\\n'",
    "ready on http"
  );
}

async function prepareTheme(page: Page, theme: Theme) {
  await setAppTheme(page, theme.id, theme.mode);
  await page.addStyleTag({ content: POLISH_CSS });
  await dismissBlockingPalette(page);
  await page.locator(SEL.worktree.mainCard).waitFor({ state: "visible", timeout: T_LONG });
  await settle(page, 1200);
  await resetNotifications(page);
  await ensureBackdropTerminal(page);
  await settle(page, 600);
}

async function captureTheme(app: ElectronApplication, page: Page, theme: Theme): Promise<void> {
  const mode = theme.mode;
  const shot = (nn: string, surface: string) => `${nn}-${surface}-${mode}`;

  await step(page, "toast", mode, async () => {
    await resetNotifications(page);
    const region = page.locator(SEL.notifications.toastRegion);
    for (const fixture of TOASTS) {
      const { expect: _text, ...opts } = fixture;
      await injectToast(page, { ...opts, duration: 0 });
      await settle(page, 100);
    }
    for (const fixture of TOASTS) {
      await region.getByText(fixture.expect).first().waitFor({ timeout: 8000 });
    }
    await page.waitForFunction(
      ({ sel, n }) => {
        const r = document.querySelector<HTMLElement>(sel);
        if (!r) return false;
        const cards = Array.from(r.querySelectorAll<HTMLElement>(":scope > [data-toast]"));
        return cards.length === n && cards.every((c) => getComputedStyle(c).opacity === "1");
      },
      { sel: SEL.notifications.toastRegion, n: TOASTS.length },
      { timeout: 8000 }
    );
    await expect(region.getByRole("button", { name: "Open review" })).toBeVisible();
    await parkPointer(page);
    await snap(page, shot("01", "toast-stack"), [region]);
    await resetNotifications(page);
  });

  await step(page, "reentry", mode, async () => {
    await resetNotifications(page);
    const mainId = await mainWorktreeId(page);
    // The summary only fires on a real blur → focus with ≥3s away, and only
    // when the window reports focus; pin hasFocus so a backgrounded test
    // window still takes the path.
    await page.evaluate(() => {
      Object.defineProperty(document, "hasFocus", { configurable: true, value: () => true });
      window.dispatchEvent(new Event("blur"));
    });
    await page.waitForTimeout(3500);
    const now = Date.now();
    const base = mainId.replace(/[\\/][^\\/]*$/, "");
    await seedNotificationHistory(page, [
      {
        id: "reentry-1",
        type: "error",
        title: "Push failed",
        message: "The remote rejected feature/checkout-redesign.",
        timestamp: now,
        context: { worktreeId: `${base}/feature-checkout` },
      },
      {
        id: "reentry-2",
        type: "success",
        title: "Claude finished",
        message: "Refactored the checkout form.",
        timestamp: now,
        context: { worktreeId: mainId },
      },
      {
        id: "reentry-3",
        type: "warning",
        title: "Codex is waiting for approval",
        message: "Codex wants to run the migration.",
        timestamp: now,
        context: { worktreeId: `${base}/db-migration` },
      },
    ]);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    const card = page.locator('[role="status"]:has(h4:text-is("While you were away"))').first();
    await card.waitFor({ state: "visible", timeout: 5000 });
    // Hover pauses the 8s auto-dismiss without restyling anything but the rows.
    await card.locator("h4").hover();
    await expect(card).toContainText("feature-checkout");
    await expect(card).toContainText("db-migration");
    await page.waitForFunction(
      (el) => el !== null && getComputedStyle(el).opacity === "1",
      await card.elementHandle(),
      { timeout: 3000 }
    );
    await snap(page, shot("02", "reentry-summary"), [card]);
    await card
      .getByRole("button", { name: "Dismiss summary" })
      .click()
      .catch(() => {});
    await page.evaluate(() => {
      delete (document as unknown as { hasFocus?: unknown }).hasFocus;
    });
    await resetNotifications(page);
  });

  await step(page, "findbar", mode, async () => {
    let panel: Locator | undefined;
    try {
      panel = await newTerminal(
        page,
        "printf 'Daintree build ok\\nDaintree tests ok\\ndaintree lint ok\\n'",
        "Daintree tests ok"
      );
      const input = panel.locator(SEL.terminal.searchInput);
      await panel.locator(".xterm").first().click({ force: true });
      await settle(page, 200);
      await page.keyboard.press("Meta+f");
      const shown = await input
        .waitFor({ state: "visible", timeout: 2500 })
        .then(() => true)
        .catch(() => false);
      if (!shown) {
        await page.evaluate(() => window.dispatchEvent(new CustomEvent("daintree:find-in-panel")));
        await input.waitFor({ state: "visible", timeout: 5000 });
      }
      await input.fill("Daintree");
      await settle(page, 700);
      const bar = input.locator(
        "xpath=ancestor::div[contains(concat(' ', @class, ' '), ' top-2 ') and contains(concat(' ', @class, ' '), ' right-2 ')][1]"
      );
      await expect(input).toHaveValue("Daintree");
      await expect(bar.getByRole("button", { name: "Next match" })).toBeEnabled();
      await parkPointer(page);
      await snap(page, shot("03", "terminal-findbar"), [bar], {
        within: await realBox(panel, "terminal pane"),
      });
      await input.press("Escape").catch(() => {});
    } finally {
      await closeTerminal(page, panel);
    }
  });

  await step(page, "scrollpill", mode, async () => {
    let panel: Locator | undefined;
    try {
      panel = await newTerminal(page, "printf 'scroll pill fixture\\n'", "scroll pill fixture");
      await runTerminalCommand(
        page,
        panel,
        // Two delayed bursts: if the first lands before the scroll-back took
        // (a loaded machine), the second gets another chance to raise the pill.
        "for i in $(seq 1 200); do echo SCRL_FILL_$i; done; sleep 8; for i in $(seq 1 20); do echo SCRL_NEW_$i; done; sleep 8; for i in $(seq 1 20); do echo SCRL_MORE_$i; done"
      );
      await waitForTerminalText(panel, "SCRL_FILL_200", 30_000);
      const pane = panel;
      const panelId = await pane.getAttribute("data-panel-id");
      const scrollBack = async (): Promise<void> => {
        await pane.locator(SEL.terminal.xtermRows).click();
        await settle(page, 200);
        for (let i = 0; i < 15; i++) await page.keyboard.press("Shift+PageUp");
        await settle(page, 300);
        await page.evaluate((id) => {
          const hooks = window as unknown as {
            __daintreeGetTerminalScrollState?: (
              id: string
            ) => { isUserScrolledBack: boolean; viewportY: number; baseY: number } | null;
            __daintreeScrollTerminalLines?: (id: string, lines: number) => unknown;
          };
          const s = hooks.__daintreeGetTerminalScrollState?.(id!);
          if (!s || !(s.isUserScrolledBack && s.viewportY < s.baseY)) {
            hooks.__daintreeScrollTerminalLines?.(id!, -80);
          }
        }, panelId);
      };
      const pill = pane.locator(SEL.terminal.scrollIndicator);
      await scrollBack();
      await waitForTerminalText(pane, "SCRL_NEW_20", 45_000);
      const raised = await pill
        .waitFor({ state: "visible", timeout: 5000 })
        .then(() => true)
        .catch(() => false);
      if (!raised) {
        await scrollBack();
        await waitForTerminalText(pane, "SCRL_MORE_20", 45_000);
        await pill.waitFor({ state: "visible", timeout: 10_000 });
      }
      await expect(pill).toContainText("New output below");
      await parkPointer(page);
      await blur(page);
      await snap(page, shot("04", "terminal-scroll-pill"), [pill], {
        pad: 120,
        within: await realBox(panel, "terminal pane"),
      });
    } finally {
      await closeTerminal(page, panel);
    }
  });

  await step(page, "artifact", mode, async () => {
    let panel: Locator | undefined;
    try {
      panel = await newTerminal(
        page,
        "printf 'Claude: wrote src/checkout/charge.ts and a README patch\\n'",
        "README patch"
      );
      const terminalId = await panel.getAttribute("data-panel-id");
      const worktreeId = await mainWorktreeId(page);
      const now = Date.now();
      // The same IPC event main raises when it extracts artifacts from agent output.
      await app.evaluate(
        ({ webContents }, payload) => {
          for (const wc of webContents.getAllWebContents()) {
            if (!wc.isDestroyed()) wc.send("artifact:detected", payload);
          }
        },
        {
          agentId: "claude",
          terminalId,
          worktreeId,
          timestamp: now,
          artifacts: [
            {
              id: "shot-code",
              type: "code",
              language: "typescript",
              filename: "src/checkout/charge.ts",
              content:
                "export async function charge(cart: Cart): Promise<Charge> {\n  const total = cart.items.reduce((sum, i) => sum + i.price * i.qty, 0);\n  return stripe.charges.create({ amount: total, currency: cart.currency });\n}\n",
              extractedAt: now,
            },
            { id: "shot-patch", type: "patch", content: PATCH, extractedAt: now },
            {
              id: "shot-summary",
              type: "summary",
              content:
                "Moved checkout to a single page and validated the card inline before submit.",
              extractedAt: now,
            },
          ],
        }
      );
      const trigger = panel.locator("[data-artifact-trigger]");
      await trigger.waitFor({ state: "visible", timeout: 10_000 });
      await trigger.click();
      const overlay = panel.locator("[data-artifact-panel]");
      await overlay.waitFor({ state: "visible", timeout: 5000 });
      await expect(overlay.locator("[data-artifact-item]")).toHaveCount(3);
      await expect(overlay).toContainText("Artifacts");
      await parkPointer(page);
      await snap(page, shot("05", "artifact-overlay"), [overlay], {
        within: await realBox(panel, "terminal pane"),
      });
    } finally {
      await closeTerminal(page, panel);
    }
  });

  await step(page, "checklist", mode, async () => {
    await page.evaluate(() => window.dispatchEvent(new Event("daintree:show-getting-started")));
    const checklist = page.locator(SEL.checklist.panel);
    await checklist.waitFor({ state: "visible", timeout: 8000 });
    await expect(checklist.locator("[data-checklist-item]").first()).toBeVisible();
    await parkPointer(page);
    await blur(page);
    await snap(page, shot("06", "getting-started-checklist"), [checklist]);
    await page
      .locator(SEL.checklist.dismissButton)
      .click({ timeout: 3000 })
      .catch(() => {});
    await checklist.waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});
  });

  await step(page, "themebrowser", mode, async () => {
    const sheet = page.locator(SEL.settings.themeBrowserDialog);
    try {
      await page.evaluate(() =>
        window.dispatchEvent(new CustomEvent("daintree:open-theme-browser"))
      );
      await sheet.waitFor({ state: "visible", timeout: T_LONG });
      await expectOnScreen(page, sheet, "theme browser");
      // The list is filtered to the committed theme's mode, so its own name is the proof it painted.
      await expect(sheet.getByText(theme.name, { exact: true }).first()).toBeVisible();
      await settle(page, 600);
      await parkPointer(page);
      await snapWindow(page, shot("07", "theme-browser-sheet"));
    } finally {
      for (let i = 0; i < 4 && (await sheet.isVisible().catch(() => false)); i++) {
        await page.keyboard.press("Escape");
        await settle(page, 300);
      }
      await sheet.waitFor({ state: "hidden", timeout: T_LONG }).catch(() => {});
    }
    await expect
      .poll(() => page.locator("html").getAttribute("data-theme"), { timeout: 5000 })
      .toBe(theme.id);
  });

  await step(page, "portal", mode, async () => {
    const region = page.locator(SEL.portal.region);
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (await region.isVisible().catch(() => false)) break;
        const result = await dispatchAction(page, "portal.toggle");
        if (result.ok === false) throw new Error(`portal.toggle failed: ${result.error?.message}`);
        await region.waitFor({ state: "visible", timeout: T_LONG }).catch(() => {});
      }
      await region.waitFor({ state: "visible", timeout: 2000 });
      await expectOnScreen(page, region, "portal dock");
      await expect(region.getByRole("button", { name: "Close portal" })).toBeVisible();
      await settle(page, 1200);
      await blur(page);
      await parkPointer(page);
      await snapWindow(page, shot("08", "portal-dock-sheet"));
    } finally {
      if (await region.isVisible().catch(() => false)) {
        await dispatchAction(page, "portal.toggle").catch(() => {});
        await region.waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});
      }
    }
  });

  await step(page, "assistant", mode, async () => {
    // The aside stays mounted while closed (inert), so open state is read
    // from `inert`, not from Playwright visibility.
    const aside = page.locator(ASSISTANT_PANEL);
    const isOpen = async () =>
      (await aside.count()) > 0 && (await aside.getAttribute("inert")) === null;
    try {
      if (!(await isOpen())) await dispatchAction(page, "help.togglePanel");
      await expect.poll(isOpen, { timeout: T_LONG }).toBe(true);
      await settle(page, 1200);
      await expectOnScreen(page, aside, "assistant panel");
      await expect(aside).toContainText(/assistant/i);
      await blur(page);
      await parkPointer(page);
      await snapWindow(page, shot("09", "assistant-panel"));
    } finally {
      if (await isOpen().catch(() => false)) {
        await dispatchAction(page, "help.togglePanel").catch(() => {});
        await expect
          .poll(isOpen, { timeout: 5000 })
          .toBe(false)
          .catch(() => {});
      }
    }
  });

  await step(page, "popover", mode, async () => {
    const now = Date.now();
    await seedNotificationHistory(page, [
      {
        id: "pop-1",
        type: "success",
        title: "Agent finished",
        message: "Claude finished refactoring the checkout form in feature/checkout-redesign.",
        timestamp: now - 2 * 60_000,
      },
      {
        id: "pop-2",
        type: "warning",
        title: "Agent waiting",
        message: "Codex is waiting for approval to run the migration.",
        timestamp: now - 9 * 60_000,
      },
      {
        id: "pop-3",
        type: "info",
        message: "Dev server restarted on port 5173.",
        timestamp: now - 40 * 60_000,
      },
    ]);
    const popover = page.locator(SEL.notifications.center);
    try {
      await page.locator(SEL.notifications.bellButton).first().click();
      await popover.waitFor({ state: "visible", timeout: 8000 });
      await expect(popover).toContainText("Codex is waiting for approval");
      await settle(page, 600);
      await blur(page);
      await parkPointer(page);
      await snap(page, shot("10", "popover-notification-center"), [popover]);
    } finally {
      await page.keyboard.press("Escape").catch(() => {});
      await popover.waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});
      await resetNotifications(page);
    }
  });

  await step(page, "toolbardrag", mode, async () => {
    try {
      const dialog = await openSettingsAt(page, "toolbar");
      const grip = dialog.locator('[aria-label^="Reorder "]').first();
      await grip.waitFor({ state: "visible", timeout: 8000 });
      await grip.scrollIntoViewIfNeeded();
      await settle(page, 400);
      const label = ((await grip.getAttribute("aria-label")) ?? "").replace(/^Reorder /, "");
      const box = await realBox(grip, "toolbar grip", 4);
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      await page.mouse.move(cx + 6, cy + 6, { steps: 3 });
      await page.mouse.move(cx + 48, cy + 56, { steps: 10 });
      const overlay = page.locator(DRAG_OVERLAY).first();
      await overlay.waitFor({ state: "visible", timeout: 5000 });
      await expect(overlay).toContainText(label);
      await settle(page, 400);
      await snap(page, shot("11", "toolbar-drag-overlay"), [overlay], {
        within: await realBox(dialog, "settings dialog"),
      });
    } finally {
      await page.keyboard.press("Escape").catch(() => {});
      await page.mouse.up().catch(() => {});
      await page
        .locator(DRAG_OVERLAY)
        .waitFor({ state: "detached", timeout: 3000 })
        .catch(() => {});
      await closeSettings(page);
    }
  });

  await step(page, "choicebox", mode, async () => {
    try {
      const dialog = await openSettingsAt(page, "assistant");
      const group = dialog.getByRole("radiogroup", { name: "Tool set" });
      await group.waitFor({ state: "visible", timeout: 10_000 });
      await group.scrollIntoViewIfNeeded();
      await settle(page, 600);
      const selected = group.locator('[role="radio"][aria-checked="true"]');
      await expect(selected).toHaveCount(1);
      const enabled = group.locator('[role="radio"]:not([aria-disabled="true"])');
      if ((await enabled.count()) === 0) throw new Error("choicebox: every card is disabled");
      await blur(page);
      await parkPointer(page);
      await snap(page, shot("12", "settings-choicebox"), [group], {
        pad: 40,
        within: await realBox(dialog, "settings dialog"),
      });
    } finally {
      await closeSettings(page);
    }
  });
}

function git(cmd: string, cwd: string): void {
  execSync(`git ${cmd}`, { cwd, stdio: "ignore" });
}

function createFixtureRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "daintree-floating-shots-"));
  git("init -b main", dir);
  git('config user.email "test@daintree.dev"', dir);
  git('config user.name "Daintree Test"', dir);
  writeFileSync(path.join(dir, "README.md"), "# Helios Dashboard\n");
  git("add -A", dir);
  git('commit -m "initial commit"', dir);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("floating surfaces — elevation across a dark and a light theme", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_FLOATING is required for the floating-elevation capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_FLOATING to run the floating-elevation capture");
  test.setTimeout(30 * 60_000);

  failures.length = 0;
  mkdirSync(OUTPUT_DIR, { recursive: true });
  if (ONLY.length === 0) {
    for (const file of readdirSync(OUTPUT_DIR)) {
      if (file.endsWith(".png")) rmSync(path.join(OUTPUT_DIR, file), { force: true });
    }
  }
  const repo = createFixtureRepo();
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-floatingshot-"));
  let ctx: AppContext | undefined;
  try {
    ctx = await launchApp({
      userDataDir,
      screenshotScale: SCALE,
      windowSize: { width: 1680, height: 1050 },
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
    });
    const page = await openAndOnboardProject(ctx.app, ctx.window, repo.dir, "Helios Dashboard");
    await dismissBlockingPalette(page);

    for (const theme of THEMES) {
      try {
        await prepareTheme(page, theme);
      } catch (error) {
        failures.push(`${theme.mode}: theme setup failed: ${String(error).split("\n")[0]}`);
        continue;
      }
      await captureTheme(ctx.app, page, theme);
    }
  } finally {
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

  const written = existsSync(OUTPUT_DIR)
    ? readdirSync(OUTPUT_DIR).filter((f) => f.endsWith(".png")).length
    : 0;
  console.warn(`[floating-shots] wrote ${written} png(s) to ${OUTPUT_DIR}`);

  if (failures.length > 0) {
    throw new Error(`[floating-shots] ${failures.length} step(s) failed:\n${failures.join("\n")}`);
  }
  if (written === 0) {
    throw new Error(`[floating-shots] no PNGs written to ${OUTPUT_DIR}`);
  }
});
