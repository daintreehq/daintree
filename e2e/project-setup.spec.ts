import { test, expect } from "@playwright/test";
import { launchApp, mockOpenDialog, type AppContext } from "./launch";
import { createFixtureRepo } from "./fixtures";

let ctx: AppContext;
let fixtureDir: string;

test.beforeAll(async () => {
  fixtureDir = createFixtureRepo("canopy-website");
  ctx = await launchApp();
});

test.afterAll(async () => {
  await ctx.app.close();
});

test("open folder and complete onboarding wizard", async () => {
  const { app, window } = ctx;

  // Mock the native file dialog to return our fixture repo
  await mockOpenDialog(app, fixtureDir);

  // Click "Open Folder" on the welcome screen
  await window.getByRole("button", { name: "Open Folder" }).click();

  // Onboarding wizard should appear
  const heading = window.locator("h2", { hasText: "Set up your project" });
  await expect(heading).toBeVisible({ timeout: 10_000 });

  // Change the project name
  const nameInput = window.getByRole("textbox", { name: "Project Name" });
  await nameInput.fill("Canopy Website");

  // Change the emoji
  await window.getByRole("button", { name: "Change project emoji" }).click();
  const emojiSearch = window.getByRole("searchbox", { name: /search emojis/i });
  await expect(emojiSearch).toBeVisible({ timeout: 3_000 });
  await emojiSearch.fill("tree");
  await window.getByRole("gridcell", { name: "Palm tree" }).click();

  // Finish onboarding
  await window.getByRole("button", { name: "Finish" }).click();

  // Wizard should close and the project should be active
  await expect(heading).not.toBeVisible({ timeout: 5_000 });

  await window.screenshot({ path: "test-results/project-setup.png" });
});
