import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { SEL } from "../helpers/selectors";
import { T_LONG } from "../helpers/timeouts";
import { execSync } from "child_process";
import { writeFileSync } from "fs";
import path from "path";

let ctx: AppContext;
let fixtureDir: string;

test.describe.serial("Core: External Git Detection", () => {
  test.beforeAll(async () => {
    fixtureDir = createFixtureRepo({ name: "external-git-detection" });
    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(
      ctx.app,
      ctx.window,
      fixtureDir,
      "External Git Detection"
    );
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
  });

  test("initial state shows clean worktree with initial commit", async () => {
    const { window } = ctx;
    const mainCard = window.locator(SEL.worktree.mainCard);

    await expect(mainCard).toBeVisible({ timeout: T_LONG });

    await expect
      .poll(() => mainCard.getAttribute("aria-label"), {
        timeout: T_LONG,
        message: "Main card should be selected",
      })
      .toContain("selected");

    await expect
      .poll(() => mainCard.getAttribute("aria-label"), {
        timeout: T_LONG,
        message: "Main card should not have uncommitted changes",
      })
      .not.toContain("has uncommitted changes");

    await expect(mainCard).toContainText("initial commit", { timeout: T_LONG });
  });

  test("detects external file creation as uncommitted changes", async () => {
    const { window } = ctx;
    const mainCard = window.locator(SEL.worktree.mainCard);

    // Pause so the monitor's self-trigger cooldown (1s) expires
    await window.waitForTimeout(2000);

    writeFileSync(path.join(fixtureDir, "external-change.txt"), "hello\n");

    await expect
      .poll(() => mainCard.getAttribute("aria-label"), {
        timeout: T_LONG,
        message: "Main card should detect uncommitted changes from external file",
      })
      .toContain("has uncommitted changes");
  });

  test("detects external commit and updates last commit message", async () => {
    const { window } = ctx;
    const mainCard = window.locator(SEL.worktree.mainCard);

    // Pause so the monitor's self-trigger cooldown (1s) expires
    await window.waitForTimeout(2000);

    execSync('git add -A && git commit -m "external-commit"', {
      cwd: fixtureDir,
      stdio: "ignore",
    });

    await expect(mainCard).toContainText("external-commit", { timeout: T_LONG });

    await expect
      .poll(() => mainCard.getAttribute("aria-label"), {
        timeout: T_LONG,
        message: "Card should be clean after committing all changes",
      })
      .not.toContain("has uncommitted changes");
  });
});
