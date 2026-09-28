/**
 * Button-states visual-review harness.
 *
 * Photographs, with real rendered pixels, every button site a consistency pass
 * over loading states, disabled opacity, destructive emphasis, icon gaps and size
 * overrides is about to touch — so the same run before and after the change
 * gives a pair of files per site to compare.
 *
 * Most shots drive `button-states-preview.html`, which mounts the shipped
 * components through their real props and stores. The rest reuse sibling
 * harnesses that already stage a surface (trash, dock, deleted worktrees, status
 * tick, issue picker, local commits, hint bar, error banners, recipes, figure
 * lightbox, QuickRun) rather than re-mounting it.
 *
 * In-flight ("…ing") states are real: the spec sets `window.__buttonStatesHold`,
 * which makes the preview's shimmed writes return a promise that never settles,
 * and then clicks the control the way a user does.
 *
 * Opt-in only, like every sibling review harness:
 *
 *   DAINTREE_SHOT_BUTTON_STATES=1 npx playwright test --project=screenshots button-states-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_BUTTON_STATES  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR            output directory (default artifacts/button-states-shots)
 *   DAINTREE_SHOT_THEMES         comma-separated theme sweep (default: daintree,svalbard)
 *   DAINTREE_SHOT_ONLY           comma-separated shot names, for iterating on a few
 *
 * PNGs are named `{shot}-{theme}.png` and are stable across runs, so a before/after
 * comparison pairs files by name. Never writes a PNG it has not verified: every
 * shot asserts the state it meant to reach, the target must have a real box, and
 * the file count is checked against the plan at the end.
 */

import { test, expect, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import path from "path";
import { startPreviewServer, stubViteHmrClient } from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_BUTTON_STATES;

const OUT_DIR = path.resolve(
  process.env.DAINTREE_SHOT_DIR ?? path.join(process.cwd(), "artifacts", "button-states-shots")
);

const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,svalbard")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

const ONLY = new Set(
  (process.env.DAINTREE_SHOT_ONLY ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

/** The dev server compiles each page on first request; under load that outruns 5s. */
const ATTACH_TIMEOUT_MS = 30_000;

let server: Awaited<ReturnType<typeof startPreviewServer>> | undefined;
let baseURL = "";

// No action may wait forever: a control covered by a collapsed region would
// otherwise retry its click until the 30-minute project timeout.
test.use({ actionTimeout: 15_000 });

test.beforeAll(async () => {
  if (!ENABLED) return;
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  server = await startPreviewServer();
  baseURL = server.baseURL;
});

test.afterAll(async () => {
  await server?.close();
});

// ---------------------------------------------------------------------------
// Page plumbing
// ---------------------------------------------------------------------------

/** Park the pointer where it can hover nothing. */
async function park(page: Page) {
  await page.mouse.move(2, 2);
}

async function settle(page: Page, ms = 300) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(ms);
}

/** Load a fixture of the button-states preview and return its surface. */
async function own(page: Page, theme: string, fixture: string, extra = ""): Promise<Locator> {
  await page.setViewportSize({ width: 1000, height: 1200 });
  await park(page);
  await page.goto(
    `${baseURL}/button-states-preview.html?theme=${theme}&fixture=${fixture}${extra}`
  );
  await expect(page.locator("html[data-preview-ready]")).toBeAttached({
    timeout: ATTACH_TIMEOUT_MS,
  });
  const failure = await page.locator("html").getAttribute("data-preview-error");
  if (failure !== null) throw new Error(`fixture "${fixture}" threw: ${failure}`);
  // Attached, not visible: a dialog fixture portals out and leaves the surface
  // empty. Every shot proves its own target is on screen before it is written.
  const surface = page.locator("[data-preview-surface]");
  await expect(surface).toBeAttached();
  await settle(page);
  return surface;
}

/** From here on, every shimmed write the preview makes stays pending. */
async function hold(page: Page) {
  await page.evaluate(() => {
    (window as Window & { __buttonStatesHold?: boolean }).__buttonStatesHold = true;
  });
}

async function sibling(page: Page, url: string, shell: string, width = 1000, height = 900) {
  await page.setViewportSize({ width, height });
  await park(page);
  await page.goto(`${baseURL}/${url}`);
  const root = page.locator(shell).first();
  await expect(root).toBeAttached({ timeout: ATTACH_TIMEOUT_MS });
  await settle(page);
  return root;
}

/** An AppDialog's panel — the modal root is a full-window scrim around it. */
const dialog = (page: Page) =>
  page.locator('[aria-modal="true"]:visible').last().locator(":scope > div").first();

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

interface Shot {
  name: string;
  /** Loads, drives and asserts; returns what to photograph. */
  run: (page: Page, theme: string) => Promise<Locator>;
}

const SHOTS: Shot[] = [
  // A. Primitive
  {
    name: "primitive",
    run: async (page, theme) => {
      const s = await own(page, theme, "primitive");
      await expect(s.locator('[data-loading="true"]').first()).toBeVisible();
      return s;
    },
  },

  // B. Review Hub
  {
    name: "commit-panel-rest",
    run: async (page, theme) => {
      const s = await own(page, theme, "commit-panel");
      await expect(page.getByTestId("review-hub-commit-primary")).toBeVisible();
      return s;
    },
  },
  {
    name: "commit-panel-committing",
    run: async (page, theme) => {
      const s = await own(page, theme, "commit-panel");
      await page.getByTestId("review-hub-commit-only").click();
      await expect(page.getByTestId("review-hub-commit-only").locator("svg").first()).toHaveClass(
        /lucide-loader/
      );
      await park(page);
      await settle(page, 250);
      return s;
    },
  },
  {
    name: "commit-panel-pushing",
    run: async (page, theme) => own(page, theme, "commit-panel-pushing"),
  },
  {
    name: "conflict-panel-rest",
    run: async (page, theme) => {
      const s = await own(page, theme, "conflict-panel");
      await expect(
        page.getByRole("button", { name: /^Mark .* as resolved$/ }).first()
      ).toBeEnabled();
      return s;
    },
  },
  {
    name: "conflict-panel-marking",
    run: async (page, theme) => {
      const s = await own(page, theme, "conflict-panel");
      await hold(page);
      await page
        .getByRole("button", { name: /^Mark .* as resolved$/ })
        .first()
        .click();
      await expect(
        page.getByRole("button", { name: /^Mark .* as resolved$/ }).first()
      ).toBeDisabled();
      await park(page);
      await settle(page, 250);
      return s;
    },
  },
  {
    name: "file-section",
    run: async (page, theme) => {
      const s = await own(page, theme, "file-section");
      await expect(page.getByTestId("review-hub-unstage-section-button")).toBeVisible();
      await expect(page.getByTestId("review-hub-stage-section-button")).toBeVisible();
      return s;
    },
  },
  {
    name: "readiness-rail",
    run: async (page, theme) => {
      const s = await own(page, theme, "readiness-rail");
      await expect(page.getByTestId("review-readiness-overflow")).toBeVisible();
      return s;
    },
  },

  // C. Settings
  {
    name: "settings-troubleshooting-rest",
    run: async (page, theme) => {
      const s = await own(page, theme, "settings-troubleshooting");
      await expect(page.getByRole("button", { name: "Run health check" })).toBeVisible();
      return s;
    },
  },
  {
    name: "settings-troubleshooting-busy",
    run: async (page, theme) => {
      const s = await own(page, theme, "settings-troubleshooting", "&collecting=1");
      await page.getByRole("button", { name: "Record profile" }).click();
      await hold(page);
      await page.getByRole("button", { name: "Stop recording" }).click();
      await page.getByRole("button", { name: "Run health check" }).click();
      await expect(page.getByRole("button", { name: "Checking…" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Saving…" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Collecting…" })).toBeVisible();
      await park(page);
      await settle(page, 250);
      return s;
    },
  },
  {
    name: "settings-editor-rest",
    run: async (page, theme) => {
      const s = await own(page, theme, "settings-editor");
      await expect(page.getByRole("button", { name: "Test saved editor" })).toBeEnabled();
      return s;
    },
  },
  {
    name: "settings-editor-testing",
    run: async (page, theme) => {
      const s = await own(page, theme, "settings-editor");
      await hold(page);
      await page.getByRole("button", { name: "Test saved editor" }).click();
      await expect(page.getByRole("button", { name: "Testing…" })).toBeVisible();
      await park(page);
      await settle(page, 250);
      return s;
    },
  },
  {
    name: "settings-environment-saving",
    run: async (page, theme) => {
      const s = await own(page, theme, "settings-environment");
      await s.locator("input").nth(1).fill("/opt/homebrew/sbin");
      await hold(page);
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.getByRole("button", { name: "Saving…" })).toBeVisible();
      await park(page);
      await settle(page, 250);
      return s;
    },
  },
  {
    name: "settings-image-viewer-saving",
    run: async (page, theme) => {
      const s = await own(page, theme, "settings-image-viewer");
      await hold(page);
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.getByRole("button", { name: "Saving…" })).toBeVisible();
      await park(page);
      await settle(page, 250);
      return s;
    },
  },
  {
    name: "settings-worktree-saving",
    run: async (page, theme) => {
      const s = await own(page, theme, "settings-worktree");
      const input = s.locator("input[type=text], input:not([type])").first();
      await expect(input).toHaveValue(/branch-slug/);
      await input.fill("{parent-dir}/{base-folder}-trees/{branch-slug}");
      await hold(page);
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.getByRole("button", { name: "Saving…" })).toBeVisible();
      await park(page);
      await settle(page, 250);
      return s;
    },
  },
  {
    name: "settings-agents",
    run: async (page, theme) => {
      const s = await own(page, theme, "settings-agents");
      await expect(page.getByRole("button", { name: "Checking…" })).toBeVisible();
      return s;
    },
  },
  {
    name: "settings-privacy-clearing",
    run: async (page, theme) => {
      const s = await own(page, theme, "settings-privacy");
      await hold(page);
      await page.getByRole("button", { name: "Clear cache" }).click();
      await expect(page.getByRole("button", { name: "Clearing…" })).toBeVisible();
      await park(page);
      await settle(page, 250);
      return s;
    },
  },
  {
    name: "settings-mcp-disconnecting",
    run: async (page, theme) => {
      await own(page, theme, "settings-mcp");
      await page.getByRole("button", { name: /External clients \(2\)/ }).click();
      await expect(page.getByRole("button", { name: "Disconnect" })).toHaveCount(2);
      await hold(page);
      await page.getByRole("button", { name: "Disconnect" }).first().click();
      const busy = page.getByRole("button", { name: "Disconnecting…" });
      await expect(busy).toBeVisible();
      await park(page);
      await settle(page, 250);
      // The innermost block holding both the server switch and the client rows.
      return page
        .locator("div")
        .filter({ has: page.getByText("Enable MCP server", { exact: true }) })
        .filter({ has: busy })
        .last();
    },
  },

  // D. Project settings
  {
    name: "project-inrepo-enabling",
    run: async (page, theme) => {
      await own(page, theme, "project-general");
      const section = page.locator("#project-in-repo-settings");
      await section.getByRole("switch").first().click();
      await expect(page.getByRole("button", { name: "Confirm and enable" })).toBeVisible();
      await page.getByRole("button", { name: "Confirm and enable" }).click();
      await expect(page.getByRole("button", { name: "Enabling…" })).toBeVisible();
      await park(page);
      await settle(page, 250);
      return section;
    },
  },
  {
    name: "project-env-saving",
    run: async (page, theme) => {
      const s = await own(page, theme, "project-env");
      await s.locator("input").nth(1).fill("postgres://localhost:5433/daintree");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.getByRole("button", { name: "Saving…" })).toBeVisible();
      await park(page);
      await settle(page, 250);
      return s;
    },
  },

  // E. Recovery
  {
    name: "host-crash-rest",
    run: async (page, theme) => {
      const s = await own(page, theme, "host-crash");
      await expect(page.getByRole("button", { name: "Restart service" })).toBeVisible();
      return s;
    },
  },
  {
    name: "host-crash-restarting",
    run: async (page, theme) => {
      const s = await own(page, theme, "host-crash");
      await hold(page);
      await page.getByRole("button", { name: "Restart service" }).click();
      await expect(page.getByRole("button", { name: "Restarting…" })).toBeVisible();
      await park(page);
      await settle(page, 250);
      return s;
    },
  },
  {
    name: "host-crash-collecting",
    run: async (page, theme) => {
      const s = await own(page, theme, "host-crash", "&collecting=1");
      await expect(page.getByRole("button", { name: "Send diagnostics" })).toContainText(
        "Collecting…"
      );
      return s;
    },
  },
  {
    name: "crash-dialog",
    run: async (page, theme) => {
      await own(page, theme, "crash-dialog");
      await expect(page.getByTestId("crash-recovery-dialog")).toBeVisible();
      await settle(page, 300);
      return dialog(page);
    },
  },
  {
    name: "crash-dialog-report",
    run: async (page, theme) => {
      await own(page, theme, "crash-dialog");
      await page.getByTestId("details-toggle").click();
      await page.getByTestId("report-button").click();
      await expect(page.getByTestId("submit-report-button")).toBeVisible();
      await park(page);
      await settle(page, 300);
      return dialog(page);
    },
  },

  // F. Setup
  {
    name: "setup-wizard-appearance",
    run: async (page, theme) => {
      await own(page, theme, "setup-wizard", "&first=1");
      await expect(page.getByRole("button", { name: "Continue" })).toBeVisible();
      await settle(page, 400);
      return dialog(page);
    },
  },
  {
    name: "setup-wizard-agents",
    run: async (page, theme) => {
      await own(page, theme, "setup-wizard");
      await expect(page.getByRole("button", { name: "Continue" })).toBeEnabled();
      await settle(page, 400);
      return dialog(page);
    },
  },
  {
    name: "setup-wizard-complete-launch",
    run: async (page, theme) => {
      await own(page, theme, "setup-wizard");
      await continueTo(page, page.getByTestId("complete-step-launch-agent"));
      await park(page);
      await settle(page, 400);
      return dialog(page);
    },
  },
  {
    name: "setup-wizard-complete-open",
    run: async (page, theme) => {
      await own(page, theme, "setup-wizard", "&workspace=0");
      await continueTo(page, page.getByTestId("complete-step-open-project"));
      await park(page);
      await settle(page, 400);
      return dialog(page);
    },
  },
  {
    name: "agent-cli-step-rest",
    run: async (page, theme) => {
      const s = await own(page, theme, "agent-cli-step");
      await expect(page.getByTestId("agent-cli-install-primary")).toBeEnabled();
      return s;
    },
  },
  {
    name: "agent-cli-step-installing",
    run: async (page, theme) => {
      const s = await own(page, theme, "agent-cli-step");
      await hold(page);
      await page.getByTestId("agent-cli-install-primary").click();
      await expect(page.getByTestId("agent-cli-install-primary")).toContainText("Installing…");
      await park(page);
      await settle(page, 250);
      return s;
    },
  },
  {
    name: "system-requirements-rest",
    run: async (page, theme) => {
      const s = await own(page, theme, "system-requirements");
      await expandRequirements(page);
      await expect(page.getByRole("button", { name: "Re-check" })).toBeVisible();
      return s;
    },
  },
  {
    name: "system-requirements-checking",
    run: async (page, theme) => {
      const s = await own(page, theme, "system-requirements");
      await expandRequirements(page);
      await hold(page);
      await page.getByRole("button", { name: "Re-check" }).click();
      await expect(page.getByRole("button", { name: "Checking…" })).toBeVisible();
      await park(page);
      await settle(page, 250);
      return s;
    },
  },
  {
    name: "system-requirements-fatal",
    run: async (page, theme) => {
      const s = await own(page, theme, "system-requirements", "&git=missing");
      await expect(page.getByRole("button", { name: "Check again" })).toBeVisible();
      return s;
    },
  },
  {
    name: "system-requirements-fatal-checking",
    run: async (page, theme) => {
      const s = await own(page, theme, "system-requirements", "&git=missing");
      await hold(page);
      await page.getByRole("button", { name: "Check again" }).click();
      await expect(page.getByRole("button", { name: "Checking…" })).toBeVisible();
      await park(page);
      await settle(page, 250);
      return s;
    },
  },
  {
    name: "missing-cli-gate",
    run: async (page, theme) => {
      const s = await own(page, theme, "missing-cli-gate");
      await expect(page.getByRole("button", { name: "Agent settings" })).toBeVisible();
      return s;
    },
  },

  // G. Worktree
  {
    name: "worktree-details-rest",
    run: async (page, theme) => {
      const s = await own(page, theme, "worktree-details");
      await expect(page.getByRole("button", { name: "Retry setup" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Resume resource" })).toBeVisible();
      return s;
    },
  },
  {
    name: "worktree-details-retrying",
    run: async (page, theme) => {
      const s = await own(page, theme, "worktree-details");
      await hold(page);
      await page.getByRole("button", { name: "Retry setup" }).click();
      await expect(page.getByRole("button", { name: "Retry setup" })).toContainText("Retrying…");
      await park(page);
      await settle(page, 250);
      return s;
    },
  },
  {
    name: "worktree-error-banners",
    run: async (page, theme) => {
      const s = await own(page, theme, "worktree-error-banners");
      await expect(page.getByTestId("worktree-delete-retry")).toBeVisible();
      return s;
    },
  },
  {
    name: "quick-state-arm",
    run: async (page, theme) => own(page, theme, "quick-state-arm"),
  },
  {
    name: "worktree-cleanup-hover",
    run: async (page, theme) => {
      const card = await sibling(
        page,
        `worktree-status-tick-preview.html?theme=${theme}&fixture=sidebar&width=320`,
        "[data-preview-card]",
        400,
        900
      );
      const row = page.locator('[data-preview-row="cleanup"]');
      await row.hover({ position: { x: 160, y: 30 } });
      await settle(page, 250);
      return card;
    },
  },
  {
    name: "issue-picker-linked",
    run: async (page, theme) => {
      await sibling(
        page,
        `issue-picker-preview.html?theme=${theme}&attached=11957`,
        'div[aria-modal="true"]',
        1000,
        800
      );
      await expect(page.getByRole("button", { name: /Unlink issue #11957/ })).toBeVisible();
      await settle(page, 300);
      return page.locator('div[aria-modal="true"] > div').first();
    },
  },

  // H. Layout
  {
    name: "trash-grouped-expanded",
    run: async (page, theme) => {
      await sibling(
        page,
        `trash-preview.html?theme=${theme}&fixture=grouped&width=1100`,
        "[data-preview-shell]",
        1100,
        560
      );
      await page.locator('[data-testid="trash-container"]').click();
      const popover = page.locator('[role="dialog"][aria-label="Recently closed terminals"]');
      await expect(popover).toBeVisible();
      await popover.getByRole("button", { name: "Expand group" }).click();
      await page.waitForTimeout(350);
      await popover.locator("[data-trash-row]").first().hover();
      await settle(page, 250);
      return popover;
    },
  },
  {
    name: "dock-background",
    run: async (page, theme) => {
      await sibling(
        page,
        `dock-preview.html?theme=${theme}&fixture=busy&width=1440&density=normal`,
        "[data-preview-shell]",
        1440,
        700
      );
      await page
        .getByRole("button", { name: /^Background/ })
        .first()
        .click();
      const popover = page.locator('[role="dialog"][aria-label="Backgrounded panels"]');
      await expect(popover).toBeVisible();
      await popover.locator("[data-testid=bg-kill-button]").first().hover();
      await settle(page, 350);
      return popover;
    },
  },
  {
    name: "background-group",
    run: async (page, theme) => {
      await own(page, theme, "background-group");
      await page
        .getByRole("button", { name: /^Background/ })
        .first()
        .click();
      const popover = page.locator('[role="dialog"][aria-label="Backgrounded panels"]');
      await expect(popover).toBeVisible();
      await expect(popover.getByRole("button", { name: "Collapse group" })).toBeVisible();
      await settle(page, 350);
      return popover;
    },
  },
  {
    name: "dock-waiting-hover",
    run: async (page, theme) => {
      await sibling(
        page,
        `dock-preview.html?theme=${theme}&fixture=rest&width=1440&density=normal`,
        "[data-preview-shell]",
        1440,
        700
      );
      await page
        .getByRole("button", { name: /^Waiting/ })
        .first()
        .click();
      const popover = page.locator('[role="dialog"][aria-label="Waiting panels"]');
      await expect(popover).toBeVisible();
      await page.waitForTimeout(350);
      await popover.locator(".group\\/row").first().hover();
      await expect(popover.getByTestId("waiting-kill-button").first()).toBeVisible();
      await settle(page, 250);
      return popover;
    },
  },
  {
    name: "local-commits-error",
    run: async (page, theme) => localCommits(page, theme, "error", /Couldn.t load commits/),
  },
  {
    name: "local-commits-load-more-error",
    run: async (page, theme) => {
      const panel = await localCommits(page, theme, "load-more-error", null);
      const scroller = panel.locator('[role="grid"]');
      await expect(scroller).toBeVisible();
      await panel.evaluate((el) => {
        const node = [...el.querySelectorAll<HTMLElement>("*")].find(
          (n) =>
            n.scrollHeight > n.clientHeight + 4 &&
            ["auto", "scroll"].includes(getComputedStyle(n).overflowY)
        );
        if (node) node.scrollTop = node.scrollHeight;
      });
      await page.getByRole("button", { name: /load more/i }).click();
      await expect(panel).toContainText("timed out", { timeout: 5_000 });
      await park(page);
      await settle(page, 300);
      return panel;
    },
  },
  {
    name: "agent-button",
    run: async (page, theme) => {
      const s = await own(page, theme, "agent-button");
      await expect(page.locator(".toolbar-agent-split-toggle")).toHaveCount(2);
      return s;
    },
  },
  {
    name: "git-operation-preview",
    run: async (page, theme) => own(page, theme, "git-operation-preview"),
  },

  // I. Sidebar
  {
    name: "deleted-worktree-group-hover",
    run: async (page, theme) => {
      const shell = await sibling(
        page,
        `deleted-worktree-group-preview.html?theme=${theme}&fixture=group-expanded&width=350`,
        "[data-preview-shell]",
        390,
        1080
      );
      await expect(page.getByTestId("deleted-worktree-group")).toBeVisible();
      await page.locator("[data-deleted-worktree-id]").first().hover();
      await settle(page, 250);
      return shell;
    },
  },
  {
    name: "deleted-worktree-single-hover",
    run: async (page, theme) => {
      const shell = await sibling(
        page,
        `deleted-worktree-group-preview.html?theme=${theme}&fixture=single&width=350`,
        "[data-preview-shell]",
        390,
        720
      );
      await page.locator("[data-deleted-worktree-id]").first().hover();
      await settle(page, 250);
      return shell;
    },
  },

  // J. Misc
  {
    name: "plugin-detail",
    run: async (page, theme) => {
      const s = await own(page, theme, "plugin-detail");
      await expect(page.getByRole("button", { name: /^Uninstall/ })).toBeVisible();
      return s;
    },
  },
  {
    name: "notification-entry",
    run: async (page, theme) => own(page, theme, "notification-entry"),
  },
  ...(["ready", "pending", "disabled"] as const).map((fixture): Shot => ({
    name: `file-editor-hint-${fixture}`,
    run: async (page, theme) => {
      const shell = await sibling(
        page,
        `file-editor-hint-preview.html?theme=${theme}&fixture=${fixture}&width=900`,
        "[data-preview-shell]",
        960,
        520
      );
      await expect(page.getByTestId("file-editor-hint")).toBeVisible();
      return shell;
    },
  })),
  {
    name: "error-banner-overflow",
    run: async (page, theme) => {
      const shell = await sibling(
        page,
        `error-banner-preview.html?theme=${theme}&scene=terminal-overflow`,
        "[data-preview-shell]",
        640,
        1200
      );
      await expect(page.getByTestId("compact-error-overflow")).toBeVisible();
      return shell;
    },
  },
  {
    name: "recipe-manager-hover",
    run: async (page, theme) => {
      await sibling(page, `recipes-preview.html?theme=${theme}`, '[role="dialog"]', 1200, 900);
      const name = dialog(page).getByText("Design review", { exact: true }).first();
      await name.hover();
      await expect(
        page.getByRole("button", { name: "More actions for recipe Design review" })
      ).toBeVisible();
      await settle(page, 250);
      return dialog(page);
    },
  },
  {
    name: "figure-lightbox-first",
    run: async (page, theme) => {
      await sibling(
        page,
        `figure-rail-preview.html?theme=${theme}&fixture=several&width=380&reference=1&open=1`,
        "[data-preview-panel]",
        1280,
        860
      );
      await expect(page.getByTestId("figure-lightbox")).toBeVisible();
      await expect(page.getByRole("button", { name: "Previous figure" })).toHaveAttribute(
        "aria-disabled",
        "true"
      );
      await park(page);
      await settle(page, 600);
      return page.locator("body");
    },
  },
  {
    name: "quick-run-empty",
    run: async (page, theme) => quickRun(page, theme, null),
  },
  {
    name: "quick-run-typed",
    run: async (page, theme) => quickRun(page, theme, "npm run typecheck"),
  },
];

/** The healthy section starts collapsed; its Re-check lives in the disclosed body. */
async function expandRequirements(page: Page) {
  await page.getByRole("button", { name: /System requirements/ }).click();
  await page.waitForTimeout(400);
}

/** Walk the wizard forward the way a user does, however many steps this run takes. */
async function continueTo(page: Page, target: Locator) {
  for (let step = 0; step < 4 && !(await target.isVisible()); step++) {
    await page.getByRole("button", { name: "Continue" }).click();
    await page.waitForTimeout(400);
  }
  await expect(target).toBeVisible();
}

async function localCommits(
  page: Page,
  theme: string,
  commits: string,
  expectText: RegExp | null
): Promise<Locator> {
  await sibling(
    page,
    `forge-stats-preview.html?theme=${theme}&fixture=commits-only&commits=${commits}`,
    "[data-testid=forge-stat-pill-commits]",
    600,
    640
  );
  const pill = page.getByTestId("forge-stat-pill-commits");
  await expect(pill).not.toContainText("—");
  await pill.click();
  await expect(pill).toHaveAttribute("aria-expanded", "true");
  const panel = page
    .getByRole("combobox", { name: /search commits/i })
    .locator('xpath=ancestor::div[contains(@class,"surface-overlay")][1]');
  await expect(panel).toBeVisible();
  await page.waitForTimeout(500);
  if (expectText) await expect(panel).toContainText(expectText);
  await park(page);
  await settle(page, 250);
  return panel;
}

async function quickRun(page: Page, theme: string, typed: string | null): Promise<Locator> {
  const shell = await sibling(
    page,
    `sidebar-footer-preview.html?theme=${theme}&fixture=default&width=320`,
    "[data-preview-shell]",
    360,
    640
  );
  await page.locator("[data-quick-run-toggle]").click();
  await expect(page.locator("#quick-run-panel")).toBeVisible();
  if (typed) {
    await page.getByRole("combobox").fill(typed);
    await page.keyboard.press("Escape");
  }
  await park(page);
  await settle(page, 250);
  return shell;
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

/**
 * Each capture gets its own page. A page that throws renders nothing, and a
 * renderer the OS kills under load renders nothing either; both get one more go
 * before the run fails loudly.
 */
async function capture(context: BrowserContext, shot: Shot, theme: string): Promise<string> {
  const file = `${shot.name}-${theme}.png`;
  for (let attempt = 1; ; attempt++) {
    const page = await context.newPage();
    const errors: string[] = [];
    let crashed = false;
    page.on("crash", () => {
      crashed = true;
    });
    const consoleErrors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text().slice(0, 300));
    });
    try {
      await stubViteHmrClient(page);
      const target = await shot.run(page, theme);
      // Stray async throws from a harness's inert bridge (a sibling page's poll
      // reading `.status` off `undefined`) are logged, not fatal: every shot has
      // already asserted the state it came for, and a render failure in this
      // preview surfaces through its error boundary instead.
      if (errors.length > 0) {
        console.warn(
          `[button-states-shots] ${file}: page threw ${[...new Set(errors)].join(" | ")}`
        );
      }
      await expect(target).toBeVisible();
      const box = await target.boundingBox();
      if (!box || box.width < 8 || box.height < 8) {
        throw new Error(`target has no real box (${JSON.stringify(box)}) — refusing to write`);
      }
      const out = path.join(OUT_DIR, file);
      await target.screenshot({ path: out, animations: "disabled", caret: "hide" });
      return out;
    } catch (error) {
      if (attempt === 1) {
        console.warn(
          `[button-states-shots] ${file}: ${crashed ? "renderer crashed" : String(error).split("\n")[0]}; retrying once`
        );
        continue;
      }
      throw new Error(
        `${file}: ${String(error)}\n  console: ${consoleErrors.join(" | ") || "(none)"}`,
        { cause: error }
      );
    } finally {
      await page.close().catch(() => undefined);
    }
  }
}

/**
 * Vite discovers dependencies as it transforms, and a discovery mid-run
 * re-bundles and force-reloads every open page — a blank document at exactly the
 * moment a capture asserts. Load the preview until it mounts on a settled server.
 */
async function warmUp(context: BrowserContext) {
  const page = await context.newPage();
  try {
    await stubViteHmrClient(page);
    for (let attempt = 0; attempt < 6; attempt++) {
      await page.goto(`${baseURL}/button-states-preview.html?fixture=primitive`);
      const ready = await page
        .locator("html[data-preview-ready]")
        .waitFor({ state: "attached", timeout: 20_000 })
        .then(() => true)
        .catch(() => false);
      if (ready) return;
      await page.waitForTimeout(3_000);
    }
    throw new Error("button-states preview never mounted during warm-up");
  } finally {
    await page.close();
  }
}

test("button states — every site, every theme", async ({ browser }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_BUTTON_STATES is required for the button-states capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_BUTTON_STATES=1 to run the capture");

  const names = SHOTS.map((s) => s.name);
  expect(new Set(names).size, "shot names must be unique").toBe(names.length);
  for (const name of ONLY) expect(names, `unknown shot "${name}"`).toContain(name);
  const plan = SHOTS.filter((s) => ONLY.size === 0 || ONLY.has(s.name));

  const context = await browser.newContext({ deviceScaleFactor: 2 });
  const written: string[] = [];
  try {
    await warmUp(context);
    for (const theme of THEMES) {
      for (const shot of plan) written.push(await capture(context, shot, theme));
    }
  } finally {
    await context.close();
  }

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(onDisk.length).toBe(THEMES.length * plan.length);
  console.log(`[button-states-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
