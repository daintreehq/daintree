/**
 * Documentation screenshots — Pilot.
 *
 * Pilot reads a fleet snapshot the main process builds from every terminal it
 * knows about, keyed by project — so agents in projects whose views have been
 * evicted keep appearing. That is what makes a three-project shot affordable:
 * one window, three projects opened in turn, an agent left running in each.
 *
 * The park editor rides the same launch. Its gate list is "every other run in
 * the fleet", so with one agent it would be a single row reading "I unpark it
 * myself" and the shot would show nothing.
 */

import { test, expect, type Page } from "@playwright/test";
import { rmSync } from "fs";
import path from "path";
import { closeApp, type AppContext } from "../helpers/launch";
import { SEL } from "../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG } from "../helpers/timeouts";
import { DOCS_DEMO_ROOT } from "../helpers/docsFixtures";
import { createCapture, resetOverlays } from "../helpers/docsCapture";
import { bootDocsApp, DOCS_WINDOW_WIDE } from "../helpers/docsBoot";
import { installFakeAgent, fakeAgentEnv } from "../helpers/fakeAgent";
import { launchDocsAgent, parkAgent } from "../helpers/docsAgents";
import { addAndSwitchToProject } from "../helpers/workflows";
import { createDemoRepo, type DemoRepo } from "../helpers/screenshotFixtures";

process.env.DAINTREE_DEMO_ROOT = DOCS_DEMO_ROOT;

const cap = createCapture("pilot");

const PROJECTS = [
  { slug: "atlas-ledger", name: "Atlas Ledger", emoji: "📒" },
  { slug: "harbor-freight", name: "Harbor Freight", emoji: "🚚" },
  { slug: "tidewater-api", name: "Tidewater API", emoji: "🌊" },
];

test.describe.serial("Documentation Screenshots — Pilot", () => {
  test.afterAll(() => {
    cap.writeReport();
  });

  test("scene-o1-pilot", async () => {
    const repos: DemoRepo[] = PROJECTS.map((p) =>
      createDemoRepo({
        slug: p.slug,
        files: {
          "README.md": `# ${p.emoji} ${p.slug}\n`,
          "src/index.ts": `// ${p.slug} entry point\n`,
        },
      })
    );
    // One bin dir on PATH serves every project — the prepend is process-wide.
    const binDir = installFakeAgent(path.dirname(repos[0].dir));

    let ctx: AppContext | undefined;
    let profile = "";
    try {
      const booted = await bootDocsApp({
        repoDir: repos[0].dir,
        displayName: PROJECTS[0].name,
        emoji: PROJECTS[0].emoji,
        env: fakeAgentEnv(binDir),
        windowSize: DOCS_WINDOW_WIDE,
      });
      ctx = booted.ctx;
      profile = booted.userDataDir;
      let page: Page = booted.page;

      // Project one: leave an agent working.
      await launchDocsAgent(page, { name: "Statement matcher" });

      // Projects two and three. Each switch recreates the WebContentsView, so
      // the Page handle must be rebound or every later locator resolves
      // against a dead view.
      for (let i = 1; i < PROJECTS.length; i++) {
        page = await addAndSwitchToProject(ctx.app, page, repos[i].dir, PROJECTS[i].name);
        await page.evaluate(
          async (o) => {
            const current = await window.electron.project.getCurrent();
            if (current?.id) {
              await window.electron.project.update(current.id, { name: o.name, emoji: o.emoji });
            }
          },
          { name: PROJECTS[i].name, emoji: PROJECTS[i].emoji }
        );
        await page.waitForTimeout(T_MEDIUM);
        const id = await launchDocsAgent(page, { name: `${PROJECTS[i].name} review` });
        // Park the middle project's agent: a waiting run is what puts a
        // demand chip on its group header, and demand is what Pilot orders by.
        if (i === 1) await parkAgent(page, id);
      }

      await cap.shot("agents/all-agents/pilot-overview", async () => {
        await resetOverlays(page);
        await page.evaluate(() => {
          window.__daintreeDispatchAction?.("pilot.toggle", undefined, { source: "user" });
        });
        const pilot = page.locator('[role="dialog"][aria-label="All agents"]');
        await expect(pilot).toBeVisible({ timeout: T_LONG });
        // Gate on the groups, not a fixed wait: Pilot renders a skeleton until
        // the first snapshot lands, and the aggregate refreshes on a 5s poll.
        await expect(pilot.locator('[data-testid="pilot-group-header"]')).toHaveCount(3, {
          timeout: T_LONG * 3,
        });
        await page.waitForTimeout(T_MEDIUM);
        await cap.snapElement(page, pilot, "agents/all-agents/pilot-overview", 0);
      });

      await cap.shot("agents/all-agents/pilot-park-editor", async () => {
        const pilot = page.locator('[role="dialog"][aria-label="All agents"]');
        await expect(pilot).toBeVisible({ timeout: T_LONG });
        await page.locator('[data-testid="pilot-search"]').press("ArrowDown");
        await page.waitForTimeout(T_SHORT);
        // Alt+Enter refuses to open the editor while the snapshot is stale, so
        // the park hint is the signal that it will take.
        await expect(page.locator('[data-testid="pilot-park-hint"]')).toBeVisible({
          timeout: T_LONG,
        });
        await page.keyboard.press("Alt+Enter");
        const editor = page.locator('[data-testid="pilot-park-editor"]');
        await expect(editor).toBeVisible({ timeout: T_LONG });
        await editor
          .locator('[data-testid="pilot-park-note"]')
          .fill("Blocked on the reconciliation review — resume after Harbor lands");
        await page.waitForTimeout(T_SHORT);
        // Capture the whole palette: cropping to the editor loses the "All
        // agents" header that says which surface this is.
        await cap.snapElement(page, pilot, "agents/all-agents/pilot-park-editor", 0);
        // Never Enter: that commits the park and closes the editor.
        await page.keyboard.press("Escape");
      });
    } finally {
      if (ctx) await closeApp(ctx.app).catch(() => {});
      for (const r of repos) r.cleanup();
      if (profile) rmSync(profile, { recursive: true, force: true });
    }
  });
});
