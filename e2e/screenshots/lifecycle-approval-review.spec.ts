/**
 * Repository command approval visual-review harness.
 *
 * `LifecycleCommandApprovalDialog` is where a user reads the shell commands a
 * repository would run with their account and decides whether to allow them.
 * What matters is whether every command is legible verbatim and whether it is
 * clear which ones run the moment the user approves and which are being
 * approved for later — so the dialog is judged on rendered pixels, across a
 * single command, a typical mix, hostile lengths and a long list.
 *
 * Renders the product's dialog through `lifecycle-approval-preview.html`; the
 * page's shim answers the review and approve requests with fixtures. No build
 * and no Electron. Each capture first asserts a string only that state puts on
 * screen, so a green run never leaves behind a picture of the wrong state.
 *
 * Opt-in only, like every sibling review harness:
 *
 *   DAINTREE_SHOT_LIFECYCLE_APPROVAL=1 DESIGN_CAPTURE_DIR=/abs/dir \
 *     npx playwright test --project=screenshots lifecycle-approval-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_LIFECYCLE_APPROVAL  required — any truthy value runs the capture
 *   DESIGN_CAPTURE_DIR                output directory (default artifacts/lifecycle-approval-shots)
 *   DAINTREE_SHOT_THEMES              comma-separated theme sweep (default: daintree,bondi)
 *   DAINTREE_SHOT_ONLY                comma-separated state filter
 *
 * Output: <state>-<theme>.png. The test counts the files itself rather than
 * trusting its own exit code.
 */

import { test, expect, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import path from "path";
import {
  makeSnap,
  startPreviewServer,
  stubViteHmrClient,
  type PreviewServer,
} from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_LIFECYCLE_APPROVAL;
const OUT_DIR = path.resolve(
  process.env.DESIGN_CAPTURE_DIR ??
    path.join(process.cwd(), "artifacts", "lifecycle-approval-shots")
);
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);
const ONLY = (process.env.DAINTREE_SHOT_ONLY ?? "").split(",").filter(Boolean);

const ATTACH_TIMEOUT_MS = 30_000;
const PAGE = "lifecycle-approval-preview.html";
/** Longer than the dialog's approve cooldown, so the primary is live. */
const COOLDOWN_WAIT_MS = 1_400;
const CARD = 'div[aria-modal="true"] > div';

const snap = makeSnap(OUT_DIR);

test.use({ deviceScaleFactor: 2 });
let server: PreviewServer | undefined;

test.beforeAll(async () => {
  if (!ENABLED) return;
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  server = await startPreviewServer();
});

test.afterAll(async () => {
  await server?.close();
});

/** Hold one page open until Vite's optimizer stops force-reloading it. */
async function settleDevServer(context: BrowserContext): Promise<void> {
  const page = await context.newPage();
  await stubViteHmrClient(page);
  let navigations = 0;
  page.on("framenavigated", () => navigations++);
  await page.goto(`${server!.baseURL}/${PAGE}?state=single`);
  for (let attempt = 0; attempt < 6; attempt++) {
    const before = navigations;
    await page.waitForTimeout(2_500);
    const ready = await page.locator("#root > *").count();
    if (navigations === before && ready > 0) break;
  }
  await page.close();
}

async function open(page: Page, state: string, theme: string): Promise<Locator> {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto(`${server!.baseURL}/${PAGE}?theme=${theme}&state=${state}`);
  await expect(page.locator("#root > *").first()).toBeAttached({ timeout: ATTACH_TIMEOUT_MS });
  await page.evaluate(() => document.fonts.ready);
  const card = page.locator(CARD).last();
  await expect(card).toBeVisible({ timeout: ATTACH_TIMEOUT_MS });
  await page.waitForTimeout(450);
  return card;
}

/** Past the approve cooldown, so every shot shows the primary in the same state. */
async function settled(page: Page, card: Locator): Promise<Locator> {
  await page.waitForTimeout(COOLDOWN_WAIT_MS);
  return card;
}

async function mustShow(within: Locator, ...texts: (string | RegExp)[]): Promise<void> {
  for (const text of texts) {
    await expect(within.getByText(text).first()).toBeVisible({ timeout: ATTACH_TIMEOUT_MS });
  }
}

interface State {
  name: string;
  capture: (page: Page, theme: string) => Promise<Locator>;
}

const STATES: State[] = [
  {
    name: "single",
    capture: async (page, theme) => {
      const card = await open(page, "single", theme);
      await mustShow(card, "npm ci");
      return settled(page, card);
    },
  },
  {
    name: "mixed",
    capture: async (page, theme) => {
      const card = await open(page, "mixed", theme);
      await mustShow(card, "npm run db:migrate", "./scripts/sandbox.sh status --json");
      await page.waitForTimeout(COOLDOWN_WAIT_MS);
      return card;
    },
  },
  {
    name: "later",
    capture: async (page, theme) => {
      const card = await open(page, "later", theme);
      await mustShow(card, "npm run db:migrate");
      await page.waitForTimeout(COOLDOWN_WAIT_MS);
      return card;
    },
  },
  {
    name: "long",
    capture: async (page, theme) => {
      const card = await open(page, "long", theme);
      await mustShow(card, /install-toolchain\.sh/, /assignPublicIp=ENABLED/);
      return settled(page, card);
    },
  },
  {
    name: "many",
    capture: async (page, theme) => {
      const card = await open(page, "many", theme);
      await mustShow(card, "corepack enable");
      return settled(page, card);
    },
  },
  {
    name: "many-end",
    capture: async (page, theme) => {
      const card = await open(page, "many", theme);
      await mustShow(card, "corepack enable");
      // Scroll every scroll box in the card to its end: the body, plus any
      // inner well, so the shot shows the bottom of the list.
      await card.evaluate((el) => {
        for (const node of [el, ...Array.from(el.querySelectorAll("*"))]) {
          if (node.scrollHeight > node.clientHeight + 1) node.scrollTop = node.scrollHeight;
        }
      });
      await mustShow(card, "fly scale count 0 --app helios-staging");
      return settled(page, card);
    },
  },
  {
    name: "nothing",
    capture: async (page, theme) => {
      const card = await open(page, "nothing", theme);
      await mustShow(card, /already approved/);
      return settled(page, card);
    },
  },
  {
    name: "loading",
    capture: async (page, theme) => {
      const card = await open(page, "loading", theme);
      await mustShow(card, /Reading commands/);
      return card;
    },
  },
  {
    name: "load-error",
    capture: async (page, theme) => {
      const card = await open(page, "load-error", theme);
      await mustShow(card, /Worktree not found/);
      return settled(page, card);
    },
  },
  {
    name: "approve-error",
    capture: async (page, theme) => {
      const card = await open(page, "approve-error", theme);
      await mustShow(card, "npm run db:migrate");
      await page.waitForTimeout(COOLDOWN_WAIT_MS);
      await card.getByRole("button", { name: /approve/i }).click();
      await mustShow(card, /These commands changed after you reviewed them/);
      await page.waitForTimeout(COOLDOWN_WAIT_MS);
      return card;
    },
  },
  {
    name: "focus",
    capture: async (page, theme) => {
      const card = await open(page, "mixed", theme);
      await mustShow(card, "npm run db:migrate");
      await page.waitForTimeout(COOLDOWN_WAIT_MS);
      await page.keyboard.press("Tab");
      await page.waitForTimeout(200);
      return card;
    },
  },
];

test.describe("lifecycle command approval review", () => {
  test("captures every state", async ({ context }) => {
    test.info().annotations.push({
      type: "conditional-skip",
      description:
        "DAINTREE_SHOT_LIFECYCLE_APPROVAL is required for the lifecycle approval capture",
    });
    test.skip(!ENABLED, "set DAINTREE_SHOT_LIFECYCLE_APPROVAL=1 to capture");
    await settleDevServer(context);
    const selected = STATES.filter((s) => ONLY.length === 0 || ONLY.includes(s.name));
    const expected: string[] = [];
    for (const theme of THEMES) {
      for (const state of selected) {
        const page = await context.newPage();
        await stubViteHmrClient(page);
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        try {
          const target = await state.capture(page, theme);
          const file = `${state.name}-${theme}.png`;
          await snap(target, file);
          if (errors.length > 0) throw new Error(`${file}: page threw: ${errors.join(" | ")}`);
          expected.push(file);
        } finally {
          await page.close().catch(() => undefined);
        }
      }
    }
    const written = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
    for (const file of expected) expect(written).toContain(file);
    expect(written.length).toBe(expected.length);
  });
});
