/**
 * Documentation screenshots — agents, presets and the unified input bar.
 *
 * Two scenes. The presets and input surfaces need one project and one or two
 * agents; the waiting popover needs three agents parked in three *different*
 * classified states, which is a three-minute stage on its own and would slow
 * everything else down if it shared a scene.
 *
 * `voice-input-recording-active` is not here. The recording state is only
 * reachable through a real `getUserMedia` session, and the app preflights
 * macOS microphone permission before it starts — on a machine that has not
 * granted it, that raises a modal OS prompt Playwright cannot dismiss. It
 * needs an E2E hook on the voice store before it can be automated.
 */

import { test, expect, type Page } from "@playwright/test";
import { chmodSync, copyFileSync, mkdirSync, rmSync, writeFileSync } from "fs";
import path from "path";
import { closeApp, type AppContext } from "../helpers/launch";
import { SEL } from "../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG } from "../helpers/timeouts";
import { createAtlasLedgerRepo, attachLocalOrigin, DOCS_DEMO_ROOT } from "../helpers/docsFixtures";
import { createCapture, resetOverlays, POLISH_CSS } from "../helpers/docsCapture";
import { bootDocsApp, DOCS_WINDOW_WIDE, DIALOG_PAD } from "../helpers/docsBoot";
import { installFakeAgent, fakeAgentEnv, FAKE_AGENT_IDLE, ptyWrite } from "../helpers/fakeAgent";
import { launchDocsAgent } from "../helpers/docsAgents";
import { openSettings } from "../helpers/panels";
import { navigateToAgentSettings } from "../helpers/presets";
import type { DemoRepo } from "../helpers/screenshotFixtures";

process.env.DAINTREE_DEMO_ROOT = DOCS_DEMO_ROOT;

const cap = createCapture("agents");

/**
 * Give the fake CLI a second identity.
 *
 * `installFakeAgent` writes only `claude`. Codex's `$` completions are driven
 * entirely by files on disk, not by the binary — but the panel still has to be
 * a codex panel rather than the missing-CLI recovery gate, and that needs
 * something named `codex` on PATH that answers `--version`.
 */
function installFakeCodex(binDir: string): void {
  const src = path.join(binDir, "claude");
  const dest = path.join(binDir, "codex");
  copyFileSync(src, dest);
  chmodSync(dest, 0o755);
}

/**
 * Seed the files Codex's `$` menu reads.
 *
 * Skills are directories holding a SKILL.md with a `description` in the
 * frontmatter; plugins are an enabled entry in config.toml intersected with a
 * cached manifest. Both are resolved from CODEX_HOME, so this has to exist
 * before launch.
 */
function seedCodexHome(root: string): void {
  const skill = (name: string, description: string) => {
    mkdirSync(path.join(root, "skills", name), { recursive: true });
    writeFileSync(
      path.join(root, "skills", name, "SKILL.md"),
      `---\ndescription: ${description}\n---\n\n# ${name}\n`
    );
  };
  skill("ledger-audit", "Reconcile a month of ledger entries against the bank statement.");
  skill("release-notes", "Draft release notes from the commits since the last tag.");

  writeFileSync(
    path.join(root, "config.toml"),
    '[plugins."gh-tools@acme"]\nenabled = true\n\n[plugins."deploy-kit@acme"]\nenabled = true\n'
  );
  const plugin = (name: string, description: string) => {
    const dir = path.join(root, "plugins", "cache", "acme", name, "1.0.0", ".codex-plugin");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "plugin.json"), JSON.stringify({ description }));
  };
  plugin("gh-tools", "Open, review and merge pull requests from the agent.");
  plugin("deploy-kit", "Promote a build through staging and production.");
}

/**
 * Drive one agent into `waiting` with a specific classified reason.
 *
 * The reason is decided in main by scanning the last dozen rendered rows of
 * the terminal, so the only lever is what is on screen when the agent goes
 * idle. Thirty blank-ish filler lines first, because the fake CLI's own boot
 * banner contains "❯ 1. Yes, I trust this folder" — which matches the approval
 * pattern verbatim and would classify every pane identically.
 */
async function parkWithReason(page: Page, panelId: string, line: string): Promise<void> {
  for (let i = 0; i < 30; i++) {
    await ptyWrite(page, panelId, "· reconciling ledger entries\r");
  }
  // Idle token first, reason line last. The token's own echo is content: sent
  // after the reason it becomes the final line, and the question classifier
  // only scans the last three — which is why a perfectly good question line
  // came back unbadged while approval and error, which scan ten and four
  // lines, still matched.
  await ptyWrite(page, panelId, `${FAKE_AGENT_IDLE}\r`);
  await page.waitForTimeout(400);
  await ptyWrite(page, panelId, `${line}\r`);
  await expect
    .poll(() => page.locator(`[data-panel-id="${panelId}"]`).getAttribute("data-agent-state"), {
      timeout: T_LONG * 6,
      intervals: [500, 1000, 2000],
    })
    .toBe("waiting");
}

test.describe.serial("Documentation Screenshots — Agents", () => {
  test.afterAll(() => {
    cap.writeReport();
  });

  // ---------------------------------------------------------------------------
  // Scene A1 — the agent roster, presets, and the input bar
  // ---------------------------------------------------------------------------
  test("scene-a1-presets-and-input", async () => {
    const repo: DemoRepo = createAtlasLedgerRepo();
    attachLocalOrigin(repo);
    // Deeply nested, similarly-named files, so the @ autocomplete has ranked
    // matches to show rather than one obvious hit.
    for (const rel of [
      "src/services/ledger/reconciliation/ReconciliationEngine.ts",
      "src/services/ledger/reconciliation/ReconciliationEngine.test.ts",
      "src/services/ledger/settlement/SettlementEngine.ts",
    ]) {
      mkdirSync(path.join(repo.dir, path.dirname(rel)), { recursive: true });
      writeFileSync(path.join(repo.dir, rel), `// ${path.basename(rel)}\n`);
    }
    // A project-shared preset, so the toolbar dropdown has more than one group.
    mkdirSync(path.join(repo.dir, ".daintree/presets/claude"), { recursive: true });
    writeFileSync(
      path.join(repo.dir, ".daintree/presets/claude/reviewer.json"),
      JSON.stringify({ id: "team-reviewer", name: "Reviewer", displayTitle: "Reviewer" }, null, 2)
    );

    const binDir = installFakeAgent(path.dirname(repo.dir));
    installFakeCodex(binDir);
    const codexHome = path.join(path.dirname(repo.dir), "codex-home");
    rmSync(codexHome, { recursive: true, force: true });
    seedCodexHome(codexHome);

    let ctx: AppContext | undefined;
    let profile = "";
    try {
      const booted = await bootDocsApp({
        repoDir: repo.dir,
        displayName: "Atlas Ledger",
        emoji: "📒",
        env: { ...fakeAgentEnv(binDir), CODEX_HOME: codexHome },
        windowSize: DOCS_WINDOW_WIDE,
      });
      ctx = booted.ctx;
      profile = booted.userDataDir;
      const { page } = booted;

      // A custom preset, so the dropdown carries a Custom group as well as the
      // project-shared one.
      await page.evaluate(async () => {
        const s = await window.electron.agentSettings.get();
        const entry = s.agents?.claude ?? {};
        await window.electron.agentSettings.set("claude", {
          ...entry,
          customPresets: [
            ...(entry.customPresets ?? []),
            { id: "zai-preset", name: "Z.AI", args: [] },
          ],
          presetId: "team-reviewer",
        } as never);
      });
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.locator(SEL.toolbar.toggleSidebar).waitFor({ state: "visible", timeout: T_LONG });
      await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
      await page.waitForTimeout(T_MEDIUM);

      await cap.shot("agents/agents-builtin-grid", async () => {
        await resetOverlays(page);
        await openSettings(page);
        await page.locator('button[role="tab"][data-tab="agents"]').click();
        const trigger = page.locator(SEL.settings.agentDropdownTrigger).first();
        await expect(trigger).toBeVisible({ timeout: T_LONG });
        await trigger.click();
        const list = page.locator(SEL.settings.agentDropdownList);
        await expect(list).toBeVisible({ timeout: T_LONG });
        await page.waitForTimeout(T_SHORT);
        const t = await trigger.boundingBox();
        const l = await list.boundingBox();
        if (!t || !l) throw new Error("agent selector has no layout");
        // Band the trigger and the list together: the list is portaled below
        // the control it belongs to, and alone it is a floating column.
        await cap.snapBand(page, "agents/agents-builtin-grid", {
          x: Math.min(t.x, l.x) - 12,
          y: t.y - 32,
          width: Math.max(t.width, l.width) + 24,
          height: l.y + l.height - t.y + 44,
        });
        await page.keyboard.press("Escape");
      });

      await cap.shot("agents/presets/agents-preset-editor-form", async () => {
        await resetOverlays(page);
        await navigateToAgentSettings(page, "claude");
        const card = page.locator(SEL.preset.section);
        await expect(card).toBeVisible({ timeout: T_LONG });
        await card.locator(SEL.preset.addButton).click({ force: true });
        const dlg = page.locator('[data-testid="add-preset-dialog"]');
        await expect(dlg).toBeVisible({ timeout: T_LONG });
        await dlg.getByText("From template").click();
        await dlg.locator('[data-testid="template-select"]').selectOption("zai");
        // The footer button is "Create preset", not "Create".
        await dlg.getByRole("button", { name: "Create preset" }).click();
        await expect(dlg).not.toBeVisible({ timeout: T_LONG });
        await card
          .locator('[data-testid="preset-display-title-input"]')
          .fill("GLM · Reconciliation");
        await page.locator(SEL.settings.heading).click({ position: { x: 4, y: 4 } });
        await page.waitForTimeout(T_SHORT);
        await card.evaluate((el) => el.scrollIntoView({ block: "start" }));
        await page.waitForTimeout(T_SHORT);
        // Clamp to the settings panel. The card is taller than the scroll
        // viewport, and the pixels past it were never rendered — an element
        // capture padded the shot with a quarter-screen of black.
        const cardBox = await card.boundingBox();
        const shell = await page.locator("div.settings-shell").first().boundingBox();
        if (!cardBox || !shell) throw new Error("preset card has no layout");
        const top = Math.max(cardBox.y - 8, shell.y + 4);
        const bottom = Math.min(cardBox.y + cardBox.height, shell.y + shell.height - 8);
        await cap.snapBand(page, "agents/presets/agents-preset-editor-form", {
          x: cardBox.x - 8,
          y: top,
          width: cardBox.width + 16,
          height: bottom - top,
        });
        await resetOverlays(page);
      });

      await cap.shot("agents/presets/agents-preset-dropdown-zones", async () => {
        await resetOverlays(page);
        // The chevron's label is "Set <Agent> preset". SEL.preset.toolbarChevron
        // is stale and matches nothing.
        const chevron = page.locator('button[aria-label="Set Claude preset"]').first();
        await expect(chevron).toBeVisible({ timeout: T_LONG });
        await chevron.click();
        const menu = page.locator('[role="menu"]').last();
        await expect(menu).toBeVisible({ timeout: T_LONG });
        // Hover a non-active row's gutter so the empty circle fades in and the
        // gutter reads as its own click zone.
        const gutter = menu
          .locator('[role="menuitem"]')
          .filter({ hasText: "Z.AI" })
          .locator('[data-zone="gutter"]')
          .first();
        if (await gutter.isVisible({ timeout: T_SHORT }).catch(() => false)) {
          await gutter.hover({ force: true });
        }
        await page.waitForTimeout(300);
        await cap.snapElement(page, menu, "agents/presets/agents-preset-dropdown-zones", 20);
        await page.keyboard.press("Escape");
      });

      await cap.shot("unified-input/unified-input-file-autocomplete", async () => {
        await resetOverlays(page);
        const panelId = await launchDocsAgent(page, { name: "Reconciliation review" });
        const panel = page.locator(`[data-panel-id="${panelId}"]`);
        const editor = panel.locator(SEL.terminal.cmEditor).first();
        await editor.click();
        // Two completed references become chips; the third is left partial so
        // the popover stays open over them.
        await page.keyboard.type(
          "@src/services/ledger/reconciliation/ReconciliationEngine.ts ",
          { delay: 8 }
        );
        await page.keyboard.type("@src/services/ledger/settlement/SettlementEngine.ts ", {
          delay: 8,
        });
        await expect(panel.locator(".cm-file-chip")).toHaveCount(2, { timeout: T_LONG });
        await page.keyboard.type("Compare @src", { delay: 30 });
        const menu = page.locator('[role="listbox"][aria-label="File autocomplete"]');
        await expect(menu).toBeVisible({ timeout: T_LONG });
        await expect(menu).not.toHaveAttribute("aria-busy", "true");
        await page.waitForTimeout(T_SHORT);
        const bar = panel.locator("[data-hybrid-input-root]").first();
        const mb = await menu.boundingBox();
        const bb = await bar.boundingBox();
        if (!mb || !bb) throw new Error("input bar has no layout");
        // The menu is absolutely positioned above the bar, i.e. outside its
        // box — one clip has to cover the union or the shot loses half itself.
        // Span both boxes horizontally, not just the menu's. The chips live
        // at the left of the input bar, which starts further left than the
        // popover — anchoring on the popover clipped them off entirely.
        const left = Math.max(0, Math.min(mb.x, bb.x) - 12);
        const right = Math.max(mb.x + mb.width, bb.x + bb.width) + 12;
        await cap.snapBand(page, "unified-input/unified-input-file-autocomplete", {
          x: left,
          y: Math.max(0, mb.y - 12),
          width: right - left,
          height: bb.y + bb.height - mb.y + 24,
        });
      });

      await cap.shot("unified-input/unified-input-codex-capabilities", async () => {
        await resetOverlays(page);
        const codexId = await launchDocsAgent(page, { agentId: "codex", name: "Codex" });
        const panel = page.locator(`[data-panel-id="${codexId}"]`);
        const editor = panel.locator(SEL.terminal.cmEditor).first();
        await editor.click();
        await page.keyboard.type("$", { delay: 40 });
        const menu = page.locator('[role="listbox"][aria-label="Capability autocomplete"]');
        await expect(menu).toBeVisible({ timeout: T_LONG });
        await page.waitForTimeout(T_SHORT);
        const bar = panel.locator("[data-hybrid-input-root]").first();
        const mb = await menu.boundingBox();
        const bb = await bar.boundingBox();
        if (!mb || !bb) throw new Error("codex input bar has no layout");
        await cap.snapBand(page, "unified-input/unified-input-codex-capabilities", {
          x: Math.max(0, mb.x - 12),
          y: Math.max(0, mb.y - 12),
          width: Math.max(mb.width, bb.width) + 24,
          height: bb.y + bb.height - mb.y + 24,
        });
      });
    } finally {
      if (ctx) await closeApp(ctx.app).catch(() => {});
      repo.cleanup();
      rmSync(codexHome, { recursive: true, force: true });
      if (profile) rmSync(profile, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------------
  // Scene A2 — the waiting popover, with three different reasons
  // ---------------------------------------------------------------------------
  test("scene-a2-waiting", async () => {
    const repo: DemoRepo = createAtlasLedgerRepo();
    attachLocalOrigin(repo);
    const binDir = installFakeAgent(path.dirname(repo.dir));

    let ctx: AppContext | undefined;
    let profile = "";
    try {
      const booted = await bootDocsApp({
        repoDir: repo.dir,
        displayName: "Atlas Ledger",
        emoji: "📒",
        env: fakeAgentEnv(binDir),
        windowSize: DOCS_WINDOW_WIDE,
      });
      ctx = booted.ctx;
      profile = booted.userDataDir;
      const { page } = booted;

      // Three separate panes, not tabs: a tab group collapses into a single
      // grouped row and the per-row reason badges disappear.
      const approval = await launchDocsAgent(page, { name: "Settlement migration" });
      await parkWithReason(page, approval, "Do you want to proceed?");

      const error = await launchDocsAgent(page, { name: "Statement importer" });
      await parkWithReason(page, error, "Error: connect ECONNREFUSED 127.0.0.1:443");

      const question = await launchDocsAgent(page, { name: "Currency table" });
      await parkWithReason(page, question, "Which migration should I run first?");

      await cap.shot("agents/states/agents-states-waiting-popover", async () => {
        await resetOverlays(page);
        const trigger = page.locator('button[aria-label^="Waiting ("]').first();
        await expect(trigger).toBeVisible({ timeout: T_LONG });
        await trigger.click();
        const pop = page.locator("#waiting-container-popover");
        await expect(pop).toBeVisible({ timeout: T_LONG });
        // Prove the classification landed. Without this the shot can ship
        // three identical unbadged rows and still look plausible.
        const rows = pop.locator('[data-testid="waiting-single-item"]');
        await expect(rows).toHaveCount(3, { timeout: T_LONG });
        await page.waitForTimeout(T_SHORT);
        await cap.snapElement(page, pop, "agents/states/agents-states-waiting-popover", 16);
      });
    } finally {
      if (ctx) await closeApp(ctx.app).catch(() => {});
      repo.cleanup();
      if (profile) rmSync(profile, { recursive: true, force: true });
    }
  });
});
