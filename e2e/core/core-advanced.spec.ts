import { test, expect } from "@playwright/test";
import { createServer, type Server } from "http";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { getGridPanelCount } from "../helpers/panels";
import {
  addAndSwitchToProject,
  selectExistingProject,
  spawnTerminalAndVerify,
} from "../helpers/workflows";
import { SEL } from "../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG, T_SETTLE } from "../helpers/timeouts";

let ctx: AppContext;
let server: Server;
let port: number;
let mainBranch: string;
let switchRepo: string;
const PROJECT_NAME = "Advanced Test";

test.describe.serial("Core: Advanced", () => {
  test.beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body><h1>E2E Test Page</h1></body></html>");
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address();
    port = typeof addr === "object" && addr ? addr.port : 0;

    const mainFixture = createFixtureRepo({
      name: "advanced-test",
      withFeatureBranch: true,
      withMultipleFiles: true,
    });
    switchRepo = createFixtureRepo({ name: "switch-project" });

    ctx = await launchApp();
    await openAndOnboardProject(ctx.app, ctx.window, mainFixture, PROJECT_NAME);
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    server?.close();
  });

  // ── Browser, Sidecar & Notes (4 tests) ───────────────────

  test.describe.serial("Browser, Sidecar & Notes", () => {
    test.afterAll(async () => {
      // Best-effort: close browser panel so Worktree tests start with clean grid
      try {
        const { window } = ctx;
        let count = await getGridPanelCount(window);
        while (count > 0) {
          const panel = window.locator(SEL.panel.gridPanel).first();
          await panel.locator(SEL.panel.close).first().click({ force: true });
          await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(count - 1);
          count--;
        }
      } catch {
        // Best-effort cleanup — do not block Worktree tests
      }
    });

    test("open browser panel via toolbar", async () => {
      const { window } = ctx;
      await window.locator(SEL.toolbar.openBrowser).click();
      const addressBar = window.locator(SEL.browser.addressBar);
      await expect(addressBar).toBeVisible({ timeout: T_LONG });
    });

    test("navigate to local server", async () => {
      const { window } = ctx;

      const addressBar = window.locator(SEL.browser.addressBar);
      await addressBar.click();
      await addressBar.fill(`http://127.0.0.1:${port}`);
      await window.keyboard.press("Enter");

      await window.waitForTimeout(T_SETTLE * 3);

      await expect(addressBar).toHaveValue(new RegExp(`127\\.0\\.0\\.1:${port}`), {
        timeout: T_MEDIUM,
      });
    });

    test("notes palette opens and shows editor", async () => {
      const { window } = ctx;

      const notesBtn = window.locator(SEL.toolbar.notesButton);
      if (!(await notesBtn.isVisible().catch(() => false))) {
        test.skip();
        return;
      }

      await notesBtn.click();

      const palette = window.locator(SEL.notes.palette);
      await expect(palette).toBeVisible({ timeout: T_MEDIUM });

      await window.keyboard.press("Escape");
      await expect(palette).not.toBeVisible({ timeout: T_SHORT });
    });
  });

  // ── Worktree Lifecycle (5 tests) ──────────────────────────

  test.describe.serial("Worktree Lifecycle", () => {
    test("main worktree card is visible and selected", async () => {
      const { window } = ctx;

      const cards = window.locator("[data-worktree-branch]");
      await expect(cards.first()).toBeVisible({ timeout: T_LONG });

      mainBranch = (await cards.first().getAttribute("data-worktree-branch")) ?? "";
      expect(mainBranch.length).toBeGreaterThan(0);

      const mainCard = window.locator(SEL.worktree.card(mainBranch));
      await expect(mainCard).toHaveAttribute("aria-label", /selected/, { timeout: T_MEDIUM });
    });

    test("create new worktree via UI", async () => {
      const { window } = ctx;

      const newBtn = window.locator('button[aria-label="Create new worktree"]');
      await newBtn.click();

      // Plus button opens the full create dialog directly
      const branchInput = window.locator(SEL.worktree.branchNameInput);
      await expect(branchInput).toBeVisible({ timeout: T_MEDIUM });
      await branchInput.fill("e2e/test-worktree");

      const pathInput = window.locator('[data-testid="worktree-path-input"]');
      await expect
        .poll(
          async () => {
            const val = await pathInput.inputValue();
            return val.trim().length;
          },
          { timeout: T_LONG, message: "Worktree path should auto-populate" }
        )
        .toBeGreaterThan(0);

      const createBtn = window.locator(SEL.worktree.createButton);
      await createBtn.click();

      const newCard = window.locator(SEL.worktree.card("e2e/test-worktree"));
      await expect(newCard).toBeVisible({ timeout: 30_000 });
    });

    test("switch to new worktree by clicking its card", async () => {
      const { window } = ctx;

      const newCard = window.locator(SEL.worktree.card("e2e/test-worktree"));
      await newCard.click();

      await expect(newCard).toHaveAttribute("aria-label", /selected/, { timeout: T_MEDIUM });
    });

    test("delete worktree via dropdown menu", async () => {
      const { window } = ctx;

      const newCard = window.locator(SEL.worktree.card("e2e/test-worktree"));
      const actionsBtn = newCard.locator(SEL.worktree.actionsMenu);
      await actionsBtn.click();

      const deleteItem = window.getByRole("menuitem", { name: /delete/i });
      await expect(deleteItem).toBeVisible({ timeout: T_SHORT });
      await deleteItem.click();

      const confirmBtn = window.locator(SEL.worktree.deleteConfirm);
      await expect(confirmBtn).toBeVisible({ timeout: T_MEDIUM });
      await confirmBtn.click();

      await expect(newCard).not.toBeVisible({ timeout: T_LONG });
    });

    test("main worktree remains after deletion", async () => {
      const { window } = ctx;

      const mainCard = window.locator(SEL.worktree.card(mainBranch));
      await expect(mainCard).toBeVisible({ timeout: T_MEDIUM });
    });
  });

  // ── Project Switch Isolation (4 tests) ────────────────────

  test.describe.serial("Project Switch Isolation", () => {
    test("open a terminal for the active project", async () => {
      const { window } = ctx;

      await spawnTerminalAndVerify(window);

      const count = await getGridPanelCount(window);
      expect(count).toBe(1);
    });

    test("switch to new project via project switcher", async () => {
      const { app, window } = ctx;

      await addAndSwitchToProject(app, window, switchRepo, "Switch Project B");
    });

    test("new project has 0 panels (isolation verified)", async () => {
      const { window } = ctx;
      await expect.poll(() => getGridPanelCount(window), { timeout: T_LONG }).toBe(0);
    });

    test("switch back to original project restores 1 panel", async () => {
      const { window } = ctx;

      await selectExistingProject(window, PROJECT_NAME);

      await expect.poll(() => getGridPanelCount(window), { timeout: T_LONG }).toBe(1);
    });
  });
});
