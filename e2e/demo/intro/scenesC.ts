import { execSync } from "child_process";
import path from "path";
import type { Director } from "./harness";
import { TASKS } from "./scenesA";

const HUB = '[data-testid="panel-dialog"]:has([data-testid="review-hub-content"])';
const DIFF = '[data-testid="panel-dialog"]:has([data-testid="diff-pane-body"])';
const FILES = [
  "src/assets/AssetLibrary.tsx",
  "src/assets/useAssets.ts",
  "src/assets/insertAsset.ts",
];

async function closeGrid(d: Director): Promise<void> {
  const ids = await d.page
    .locator('[data-panel-location="grid"][data-panel-id]')
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-panel-id")!));
  for (const id of ids) await d.dispatch("terminal.close", { terminalId: id }).catch(() => {});
}

/** 170.5 – 217.2: review the diff, open a file, stage and commit by hand. */
export async function sceneReview(d: Director): Promise<void> {
  await d.selectWorktree("feature/asset-library");
  // Real agents in this worktree keep editing; stop them so the diff holds still on camera.
  await closeGrid(d);
  // Real agents stage their own work; unstage so the staging beats have something to do.
  {
    const wt = path.join(
      path.dirname(d.projects.get("brush-cms")!.repo.dir),
      "brush-cms-worktrees",
      "feature-asset-library"
    );
    execSync("git reset -q", { cwd: wt, stdio: "ignore" });
  }
  // Let the "Moved to trash" toast clear before the take starts.
  await d.page.waitForTimeout(4500);
  const branch = "feature/asset-library";

  await d.beginScene("G-review", 170.5, 217.2);
  await d.beat(171.2, "to card", () => d.moveTo(`[data-worktree-branch="${branch}"]`, 1000));
  await d.beat(174.2, "open review", async () => {
    const btn = d.page
      .locator(
        `[data-worktree-row]:has([data-worktree-branch="${branch}"]) [aria-label^="Open Review &"]`
      )
      .first();
    if (await btn.isVisible().catch(() => false)) {
      await d.click(btn, 600);
    } else {
      await d.demo("click");
      await d.dispatch("worktree.openReviewHub", { worktreeId: await d.worktreeId(branch) });
    }
  });
  for (const [i, f] of FILES.entries()) {
    await d.beat(185.2 + i * 2.4, `hover ${f}`, () =>
      d.moveTo(`${HUB} [aria-label="View diff: ${f}"]`, 800, 0.2, 0.5)
    );
  }
  await d.beat(195.2, "open diff", () =>
    d.click(`${HUB} [aria-label="View diff: ${FILES[0]}"]`, 500)
  );
  await d.beat(196.8, "scroll diff", async () => {
    await d.moveTo(`${DIFF} [data-testid="diff-pane-body"]`, 600, 0.5, 0.6);
    await d.page.mouse.wheel(0, 180).catch(() => {});
  });
  await d.beat(199.4, "close diff", () => d.click(`${DIFF} [aria-label="Close dialog"]`, 600));
  // The hub opens with everything staged; unstage, then stage each file by hand.
  await d.beat(199.9, "unstage all", () =>
    d.click(`${HUB} [data-testid="review-hub-unstage-section-button"]`, 450)
  );
  for (const [i, f] of FILES.entries()) {
    await d.beat(201.3 + i * 1.3, `stage ${f}`, async () => {
      // Rows reflow as each file moves to Staged; confirm the stage landed and retry once.
      const btn = `${HUB} [aria-label="Stage ${f}"]`;
      await d.click(btn, 400);
      await d.page.waitForTimeout(450);
      if (
        await d.page
          .locator(btn)
          .first()
          .isVisible()
          .catch(() => false)
      )
        await d.click(btn, 200);
    });
  }
  await d.beat(205.3, "type message", async () => {
    const box = d.page.locator(`${HUB} textarea[placeholder="Commit message…"]`).first();
    await d.moveTo(box, 350);
    await d.demo("click");
    await box.focus();
    // Real keystrokes into the focused box: the demo typer can drop the first character.
    await d.page.keyboard.type("Add searchable asset library", { delay: 45 });
  });
  await d.beat(207.9, "commit", () =>
    d.click(
      d.page
        .locator(`${HUB} button`)
        .filter({ hasText: /^Commit \(\d+\)$/ })
        .first(),
      400
    )
  );
  await d.beat(210.0, "rest", () => d.demo("moveTo", 60, 55, 1500));
  await d.beat(215.8, "close hub", () => d.page.keyboard.press("Escape"));
  await d.endScene(217.2);
}

async function openPluginManager(d: Director): Promise<void> {
  await d.page.evaluate(() =>
    window.dispatchEvent(new CustomEvent("daintree:open-plugin-manager"))
  );
}

/** 217.2 – 285.7: global plugins, then a project plugin dashboard over markdown. */
export async function scenePlugins(d: Director): Promise<void> {
  await d.selectWorktree("main");
  await d.page.waitForTimeout(1000);
  const row = (name: string) =>
    d.page.locator('[data-testid="plugin-list"] li').filter({ hasText: name }).first();

  await d.beginScene("H-plugins", 217.2, 285.7);
  await d.beat(221.2, "open manager", async () => {
    await d.demo("moveTo", 50, 50, 600);
    await openPluginManager(d);
  });
  await d.beat(224.5, "hover list", () => d.moveTo('[data-testid="plugin-list"]', 1200, 0.5, 0.2));
  await d.beat(239.8, "docker", () => d.click(row("Docker").locator("button").first(), 700));
  await d.beat(242.6, "flutter", () => d.click(row("Flutter").locator("button").first(), 600));
  await d.beat(245.2, "workflow", () =>
    d.click(row("Release Workflow").locator("button").first(), 600)
  );
  await d.beat(250.8, "close manager", () => d.page.keyboard.press("Escape"));
  await d.beat(251.4, "switch to studio", async () => {
    await d.moveTo('[data-testid="project-switcher-trigger"]', 500);
    await d.demo("click");
    const opt = d.page
      .locator('[data-testid="project-switcher-palette"] [role="option"]')
      .filter({ hasText: "Video Studio" })
      .first();
    await d.moveTo(opt, 450);
    await d.demo("click");
    await d.page.waitForTimeout(400);
    await d.follow();
  });
  await d.beat(254.6, "project plugins section", async () => {
    await openPluginManager(d);
    await d.page.waitForTimeout(400);
    const heading = d.page.locator("#plugin-category-this-project");
    await heading.scrollIntoViewIfNeeded().catch(() => {});
    await d.moveTo(heading, 600);
  });
  await d.beat(256.4, "select project plugin", () =>
    d.click(row("Video Dashboard").locator("button").first(), 600)
  );
  await d.beat(259.4, "close manager", () => d.page.keyboard.press("Escape"));
  await d.beat(259.9, "open script", () =>
    d.dispatch("file.openPanel", {
      path: `${d.projects.get("video-studio")!.repo.dir}/videos/daintree-intro.md`,
      viewMode: "rendered",
    })
  );
  await d.beat(264.8, "open research", () => d.dispatch("worktree.openFileBrowserPanel", {}));
  await d.beat(271.2, "open dashboard", async () => {
    await closeGrid(d);
    const kind = await d.page.evaluate(async () =>
      ((await (window as any).electron.plugin.getPanelKinds()) as any[]).find((k) =>
        String(k.id ?? k.kind ?? "").includes("studio.videos")
      )
    );
    const id = kind?.id ?? kind?.kind;
    if (!id) throw new Error("dashboard panel kind not registered");
    await d.dispatch("panel.openPluginPanel", { kind: id });
  });
  await d.beat(274.0, "hover cards", () => d.moveTo('[data-testid="video-card"]', 900));
  await d.beat(276.2, "hover more", () =>
    d.moveTo(d.page.locator('[data-testid="video-card"]').nth(2), 900)
  );
  await d.beat(278.6, "open card", () =>
    d.click('[data-testid="video-card"][data-slug="daintree-intro"]', 700)
  );
  await d.beat(280.2, "edit mode", async () => {
    await d.page.waitForTimeout(300);
    await d.click(
      d.page
        .getByRole("radio", { name: "Edit" })
        .or(d.page.getByRole("button", { name: "Edit", exact: true }))
        .first(),
      500
    );
  });
  await d.beat(281.6, "type edit", async () => {
    const ed = '[data-panel-location="grid"] .cm-content';
    await d.moveTo(d.page.locator(ed).last(), 400, 0.3, 0.2);
    await d.demo("click");
    await d.page.keyboard.press("Meta+ArrowDown").catch(() => {});
    await d.page.keyboard.type("\nThat's Daintree.", { delay: 55 });
  });
  await d.endScene(285.7);
}

/** 285.7 – 304.6: wide shot, source on GitHub, daintree.org. */
export async function sceneOutro(d: Director): Promise<void> {
  await d.switchProject("brush-cms");
  await d.selectWorktree("main");
  await closeGrid(d);
  const outroAgents = ["claude", "codex", "grok"];
  for (const [i, t] of [TASKS.toolbar!, TASKS.api!, TASKS.assets!].entries()) {
    await d.agent({ worktree: "main", task: t, agentId: outroAgents[i] });
  }
  // The browser panel opens on the local dev server before the take; the outro only navigates.
  const launched = await d.dispatch<{ terminalId: string }>("agent.launch", {
    agentId: "browser",
    worktreeId: await d.worktreeId("main"),
    location: "grid",
    force: true,
  });
  const browserId = launched.terminalId;
  await d.page.waitForTimeout(4000);
  // Warm both pages off camera so the narrated navigations land in time, then return
  // the panel to the dev server for the start of the take.
  await d.navigateBrowser(browserId, "https://github.com/daintreehq/daintree");
  await d.page.waitForTimeout(9000);
  await d.navigateBrowser(browserId, "https://daintree.org");
  await d.page.waitForTimeout(6000);
  await d.navigateBrowser(browserId, "http://localhost:3000");
  await d.page.waitForTimeout(2500);

  await d.beginScene("I-outro", 285.7, 304.6);
  await d.beat(286.4, "rest", () => d.demo("moveTo", 58, 52, 1600));
  await d.beat(290.9, "maximize browser", () =>
    d.click(`[data-panel-id="${browserId}"] [aria-label*="Maximize"]`, 700)
  );
  await d.beat(291.9, "github", () =>
    d.navigateBrowser(browserId, "https://github.com/daintreehq/daintree")
  );
  await d.beat(296.0, "daintree.org", () => d.navigateBrowser(browserId, "https://daintree.org"));
  await d.beat(299.5, "rest on site", () =>
    d.moveTo(`[data-panel-id="${browserId}"]`, 1400, 0.55, 0.6)
  );
  await d.endScene(304.6);
}
