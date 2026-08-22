/**
 * Documentation screenshots — Settings surfaces.
 *
 * One launch, one dialog, thirteen states. The settings dialog is cheap to
 * navigate and expensive to boot, so the whole domain rides a single app.
 *
 * Ordering is not cosmetic. Three shots mutate state that later shots would
 * otherwise inherit: the env-editor pair rewrites the agent's globalEnv, the
 * in-repo toggle can write files into the fixture repo, and the accent
 * override is global and would tint every frame after it. Each is contained
 * where it sits, and the accent shot runs last as a backstop.
 */

import { test, expect, type Page } from "@playwright/test";
import { execSync } from "child_process";
import { mkdirSync, writeFileSync } from "fs";
import path from "path";
import { closeApp, type AppContext } from "../helpers/launch";
import { SEL } from "../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG } from "../helpers/timeouts";
import { createAtlasLedgerRepo, attachLocalOrigin, DOCS_DEMO_ROOT } from "../helpers/docsFixtures";
import { createCapture, resetOverlays, POLISH_CSS } from "../helpers/docsCapture";
import { bootDocsApp, DIALOG_PAD, DOCS_WINDOW_TALL } from "../helpers/docsBoot";
import { openSettings } from "../helpers/panels";
import { navigateToAgentSettings, writeCcrConfig } from "../helpers/presets";
import { saveCurrentProjectSettings } from "../helpers/projectSettings";
import type { DemoRepo } from "../helpers/screenshotFixtures";

process.env.DAINTREE_DEMO_ROOT = DOCS_DEMO_ROOT;

const cap = createCapture("settings");

/** A settings sidebar tab. Ids come from settingsTabIds.ts. */
const tab = (id: string) => `button[role="tab"][data-tab="${id}"]`;
const subtab = (id: string) => `[aria-label="Subtab navigation"] [data-tab="${id}"]`;

/** Switch the dialog between Global and Project scope. */
async function setScope(page: Page, scope: "Global" | "Project"): Promise<void> {
  await page.locator(SEL.settings.scopeSelect).click();
  await page.locator('[role="option"]', { hasText: scope }).first().click();
  // Gate on the scope having actually changed, not on "no listbox anywhere":
  // the settings panels own listboxes of their own, so a blanket count of 0
  // fails as soon as one of them is mounted — and it throws outside any shot
  // wrapper, taking the rest of the scene with it.
  const marker = scope === "Project" ? tab("project:general") : tab("general");
  await expect(page.locator(marker)).toBeVisible({ timeout: T_LONG });
  await page.waitForTimeout(T_SHORT);
}

/**
 * Make sure the settings dialog is the frontmost surface and open.
 *
 * Cheap to call and worth calling between shots that press accelerators: the
 * dialog is a `fixed inset-0` backdrop, so anything that lands on top of it
 * makes every tab click time out on actionability rather than fail loudly.
 */
async function ensureSettingsOpen(page: Page): Promise<void> {
  const heading = page.locator(SEL.settings.heading);
  if (await heading.isVisible({ timeout: 1_000 }).catch(() => false)) return;
  await openSettings(page);
  await expect(heading).toBeVisible({ timeout: T_LONG });
}

/** The settings panel card, for band captures anchored off the sidebar. */
async function sidebarBox(page: Page) {
  const box = await page.locator(SEL.settings.navSidebar).boundingBox();
  if (!box) throw new Error("settings sidebar has no bounding box");
  return box;
}

test.describe.serial("Documentation Screenshots — Settings", () => {
  test.afterAll(() => {
    cap.writeReport();
  });

  test("scene-s1-settings", async () => {
    const repo: DemoRepo = createAtlasLedgerRepo();
    attachLocalOrigin(repo);

    // Extra remotes so the Code Forge routing table has more than one row to
    // resolve. github.com matches the builtin GitHub provider by hostname;
    // gitlab.com deliberately does not, so the table shows both outcomes.
    execSync(
      `git remote add upstream https://github.com/atlas-ledger/atlas-ledger.git`,
      { cwd: repo.dir, stdio: "ignore" }
    );
    execSync(`git remote add mirror https://gitlab.com/atlas-ledger/atlas-ledger.git`, {
      cwd: repo.dir,
      stdio: "ignore",
    });

    // A project-shared preset, so the preset selector has more than one group.
    // Read from the repo at load time, so it has to exist before boot.
    mkdirSync(path.join(repo.dir, ".daintree/presets/claude"), { recursive: true });
    writeFileSync(
      path.join(repo.dir, ".daintree/presets/claude/reviewer.json"),
      JSON.stringify({ id: "team-reviewer", name: "Team reviewer", args: [] }, null, 2)
    );
    writeCcrConfig([
      { name: "sonnet-fast", model: "claude-sonnet-4" },
      { name: "opus-deep", model: "claude-opus-4" },
    ]);

    let ctx: AppContext | undefined;
    try {
      const booted = await bootDocsApp({
        repoDir: repo.dir,
        displayName: "Atlas Ledger",
        emoji: "📒",
        // The settings dialog is capped at 75vh; at 820 the taller panels
        // (telemetry, the preset editor, the in-repo confirmation) scroll
        // internally and lose their feet.
        windowSize: DOCS_WINDOW_TALL,
      });
      ctx = booted.ctx;
      const { page } = booted;

      // Seed everything the panels read before the dialog opens. The dialog
      // snapshots global env once per open and the project form initialises
      // once per open, so seeding afterwards would show stale values.
      await page.evaluate(() =>
        window.electron.globalEnv.set({
          EDITOR: "code --wait",
          LEDGER_API_URL: "https://api.atlas-ledger.internal",
          NODE_OPTIONS: "--max-old-space-size=4096",
        })
      );
      await saveCurrentProjectSettings(page, {
        terminalSettings: { shell: "/opt/homebrew/bin/fish" },
        environmentVariables: {
          NODE_OPTIONS: "--max-old-space-size=8192",
          LEDGER_ENV: "staging",
          STRIPE_SECRET_KEY: "sk_test_51LocalOnlyFixture",
        },
      } as never);
      // The agent entry backs the preset selector, the env editor and the
      // import dialog. One write, three shots.
      await page.evaluate(async () => {
        const s = await window.electron.agentSettings.get();
        const entry = s.agents?.claude ?? {};
        await window.electron.agentSettings.set("claude", {
          ...entry,
          globalEnv: {
            ANTHROPIC_BASE_URL: "https://api.anthropic.com",
            NODE_OPTIONS: "--max-old-space-size=4096",
            HTTP_PROXY: "http://127.0.0.1:3128",
          },
          customPresets: [
            ...(entry.customPresets ?? []),
            {
              id: "docs-preset-review",
              name: "Deep review",
              args: [],
              env: {
                // Overrides an inherited key → green stripe.
                NODE_OPTIONS: "--max-old-space-size=8192",
                // Matches the secret heuristic → amber stripe + advisory.
                // Amber wins over green, so these must be separate rows.
                ANTHROPIC_AUTH_TOKEN: "sk-ant-api03-3Xk9QpR7vN2wLcH4tYbZmF8sQ1dJ6g",
              },
            },
          ],
          presetId: "docs-preset-review",
        } as never);
      });

      // Reload before opening the dialog. `agentSettings.set` persists through
      // main, but the renderer's preset store hydrated at boot and does not
      // re-read on write — without this the scope picker offers only
      // "Default (all worktrees)" and the custom preset's env editor, which
      // three shots depend on, never mounts.
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.locator(SEL.toolbar.toggleSidebar).waitFor({ state: "visible", timeout: T_LONG });
      await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
      await page.waitForTimeout(T_MEDIUM);

      await openSettings(page);
      await expect(page.locator(SEL.settings.heading)).toBeVisible({ timeout: T_LONG });

      // ----------------------------------------------------------------------
      // Keyboard rebind. Done first: it is the only shot that wants a pristine
      // sidebar with no dots on it yet.
      // ----------------------------------------------------------------------
      await cap.shot("settings/global/settings-keyboard-rebind", async () => {
        try {
          await page.locator(tab("keyboard")).click();
          await page.locator(SEL.settings.shortcutsSearchInput).fill("close");
          await page.waitForTimeout(T_SHORT);
          const row = page
            .locator(SEL.settings.shortcutRow)
            .filter({ hasText: "Close focused terminal" })
            .first();
          await row.scrollIntoViewIfNeeded();
          await row.hover();
          await row.getByRole("button", { name: "Edit" }).click();

          // Edit only swaps the row into the capture widget — it does not
          // start recording. The widget opens on "Click to record shortcut",
          // and until that is pressed every keystroke goes to the app.
          await row.locator(SEL.settings.shortcutRecordPrompt).click();
          // Cmd+J is fleet.armFocused at global scope, so it conflicts, and
          // with no focused terminal behind the dialog its action is a no-op.
          // Cmd+P would conflict too, but the recorder does not swallow the
          // keystroke: nav.quickSwitcher also fires, and the palette's
          // full-screen scrim then blocks every later click in the scene.
          await page.keyboard.press("Meta+KeyJ");
          // Prompt and conflict cannot coexist outside a 1s chord window, so
          // wait the chord out and photograph the stable post-capture state:
          // combo chip + conflict + Unbind.
          await page.waitForTimeout(1400);
          await expect(page.locator("text=Conflicts with:")).toBeVisible({ timeout: T_MEDIUM });

          const top = await page.locator(SEL.settings.shortcutsSearchInput).boundingBox();
          const rowBox = await row.boundingBox();
          if (!top || !rowBox) throw new Error("keyboard tab has no layout");
          await cap.snapBand(page, "settings/global/settings-keyboard-rebind", {
            x: top.x - 12,
            y: top.y - 16,
            width: 664,
            height: rowBox.y + rowBox.height - top.y + 56,
          });
        } finally {
          // Always unwind, and scope Cancel to the editing row — a bare
          // `button:has-text("Cancel")` can resolve elsewhere in the dialog
          // and leave the recorder up. The recorder swallows every click in
          // the dialog, so one broken shot took the next four down with it.
          await page
            .locator(`${SEL.settings.shortcutRow} button:has-text("Cancel")`)
            .first()
            .click({ timeout: 3_000 })
            .catch(() => {});
          await expect(page.locator(SEL.settings.shortcutRecordPrompt))
            .toHaveCount(0, { timeout: 5_000 })
            .catch(() => {});
          await page.locator(SEL.settings.searchClear).click({ timeout: 3_000 }).catch(() => {});
        }
      });

      // A recorded combo still reaches the app — the capture widget does not
      // swallow it — so a bound accelerator can open a palette over Settings,
      // or close the dialog outright. Reconcile before the next shot rather
      // than letting every later click time out against a stale backdrop.
      await ensureSettingsOpen(page);

      // ----------------------------------------------------------------------
      // The two sidebar dots. Both can be on screen at once — visited panels
      // stay mounted, so the validation error survives switching tabs.
      // ----------------------------------------------------------------------
      await cap.shot("settings/settings-modified-indicator", async () => {
        await page.locator(tab("general")).click();
        await page.locator(subtab("display")).click();
        await page.locator('[aria-label="Grid Panel Agent Highlights Toggle"]').click();
        await expect(
          page.locator(`${tab("general")} [aria-label="Modified from default"]`)
        ).toBeVisible({ timeout: T_MEDIUM });
        const sb = await sidebarBox(page);
        await cap.snapBand(page, "settings/settings-modified-indicator", {
          x: sb.x - 8,
          y: sb.y - 8,
          width: 620,
          height: sb.height + 16,
        });
      });

      await cap.shot("settings/settings-validation-badge", async () => {
        await page.locator(tab("environment")).click();
        await page.locator('button:has-text("Add Variable")').click();
        await page.locator('[aria-label="Environment variable name"]').last().fill("1bad");
        await page.locator('[aria-label="Environment variable value"]').last().fill("nope");
        // rowErrors is only populated by validate(), which only runs on Save.
        // Typing an invalid key alone produces no dot.
        await page.locator('button:has-text("Save")').first().click();
        await expect(
          page.locator(`${tab("environment")} [aria-label="Contains validation errors"]`)
        ).toBeVisible({ timeout: T_MEDIUM });
        const sb = await sidebarBox(page);
        await cap.snapBand(page, "settings/settings-validation-badge", {
          x: sb.x - 8,
          y: sb.y - 8,
          width: 620,
          height: sb.height + 16,
        });
        // Discard so the invalid row does not follow us into later frames.
        await page.locator('button:has-text("Discard")').first().click().catch(() => {});
      });

      // ----------------------------------------------------------------------
      // Telemetry levels.
      // ----------------------------------------------------------------------
      await cap.shot("security/privacy-and-data/security-telemetry-levels", async () => {
        await page.locator(tab("privacy")).click();
        await page.locator(subtab("telemetry")).click();
        // boot() dismisses the telemetry consent, so the level is whatever
        // that wrote. Pick one explicitly rather than photographing a default.
        await page.locator('button:has-text("Off")').first().click();
        await expect(page.locator("#telemetry-disclosure-heading")).toBeVisible({
          timeout: T_MEDIUM,
        });
        const first = await page.locator('button:has-text("Off")').first().boundingBox();
        // End on the Preview row, not inside the disclosure. The disclosure
        // lists all three levels and runs past the panel's scroll viewport, so
        // a band that reaches into it ends mid-sentence over unrendered space
        // — a black bar that reads as a broken image.
        // Stop on the restart note, which closes the level picker as a unit.
        // Reaching into the Preview card below it clips that card mid-sentence,
        // and reaching further into the disclosure runs past the panel's
        // scroll viewport into unrendered black.
        const note = await page
          .getByText("Changes to telemetry level take effect", { exact: false })
          .first()
          .boundingBox()
          .catch(() => null);
        const intro = await page
          .getByText("Control what data Daintree collects", { exact: false })
          .first()
          .boundingBox()
          .catch(() => null);
        if (!first) throw new Error("telemetry levels have no layout");
        const top = Math.max(0, (intro ? intro.y : first.y - 44) - 44);
        const stop = note ? note.y + note.height + 16 : first.y + 400;
        await cap.snapBand(page, "security/privacy-and-data/security-telemetry-levels", {
          x: first.x - 12,
          y: top,
          width: first.width + 24,
          height: stop - top,
        });
      });

      // ----------------------------------------------------------------------
      // The env editor and the two-step .env import. These mutate the agent's
      // globalEnv, so they sit together and the import is always cancelled.
      // ----------------------------------------------------------------------
      await cap.shot("settings/project/settings-env-editor", async () => {
        await ensureSettingsOpen(page);
        await navigateToAgentSettings(page, "claude");
        // The agents tab mounts its panels asynchronously; without this the
        // selector click lands before the Runtime settings card exists and
        // times out on an element that is about to appear.
        await expect(page.locator(SEL.preset.section)).toBeVisible({ timeout: T_LONG });
        await page.locator(SEL.preset.section).scrollIntoViewIfNeeded();
        // Inheritance only exists on a custom preset — the Default scope's
        // editor has no inherited rows and so no override stripe and no
        // "+ override" affordance. Select the seeded preset explicitly rather
        // than trusting the stored presetId to have been picked up.
        await page.locator(SEL.preset.selectorTrigger).click();
        await page
          .locator(`${SEL.preset.selectorListbox} [role="option"]`, { hasText: "Deep review" })
          .first()
          .click();
        await page.waitForTimeout(T_SHORT);
        const editor = page.locator('[data-testid="preset-env-editor"]');
        await editor.scrollIntoViewIfNeeded();
        await expect(editor.locator('[data-testid="env-editor-warning-secret"]')).toBeVisible({
          timeout: T_MEDIUM,
        });
        // Two of the three globals stay un-overridden (ANTHROPIC_BASE_URL and
        // HTTP_PROXY), so this is "at least one muted inherited row", not one.
        expect(
          await editor.locator('[data-testid="env-editor-row-inherited"]').count()
        ).toBeGreaterThan(0);
        await cap.snapElement(page, editor, "settings/project/settings-env-editor", 10);
      });

      await cap.shot("settings/project/settings-import-env-paste", async () => {
        await ensureSettingsOpen(page);
        await navigateToAgentSettings(page, "claude");
        await expect(page.locator(SEL.preset.section)).toBeVisible({ timeout: T_LONG });
        // Import against the Default scope: its editor has no inherited rows,
        // so the conflict list is only the pasted-vs-stored comparison.
        await page.locator(SEL.preset.selectorTrigger).click();
        await page.locator(SEL.preset.defaultOption).click();
        const ge = page.locator('[data-testid="global-env-editor"]');
        await ge.scrollIntoViewIfNeeded();
        await ge.locator('[data-testid="env-editor-import"]').click();
        const dlg = page.locator('[data-testid="import-env-dialog"]');
        await expect(dlg).toBeVisible({ timeout: T_MEDIUM });
        await dlg.locator('[data-testid="import-env-textarea"]').fill(
          `# Atlas Ledger service env
ANTHROPIC_BASE_URL=https://gateway.atlas-ledger.internal/anthropic
export NODE_OPTIONS="--max-old-space-size=8192"
LEDGER_REGION=eu-west-1
LEDGER_TRACE=1
`
        );
        await expect(dlg.locator('[data-testid="import-env-summary"]')).toBeVisible({
          timeout: T_MEDIUM,
        });
        // The AppDialog root is the full-screen backdrop; the card is its child.
        await cap.snapElement(
          page,
          dlg.locator("> div").first(),
          "settings/project/settings-import-env-paste",
          DIALOG_PAD
        );
      });

      await cap.shot("settings/project/settings-import-env-conflicts", async () => {
        const dlg = page.locator('[data-testid="import-env-dialog"]');
        await dlg.getByRole("button", { name: /Review 2 conflicts/ }).click();
        await expect(dlg.locator('[data-testid="import-env-conflict-list"]')).toBeVisible({
          timeout: T_MEDIUM,
        });
        await dlg.locator('[data-testid="import-env-mode-overwrite"]').click();
        await cap.snapElement(
          page,
          dlg.locator("> div").first(),
          "settings/project/settings-import-env-conflicts",
          DIALOG_PAD
        );
        // Cancel, never Import: importing rewrites globalEnv and would break
        // the env-editor shot on any recapture that reorders these.
        await page.keyboard.press("Escape");
        await expect(dlg).not.toBeVisible({ timeout: T_MEDIUM });
      });

      // ----------------------------------------------------------------------
      // Preset selector.
      // ----------------------------------------------------------------------
      await cap.shot("settings/global/settings-preset-selector", async () => {
        await page.locator(SEL.preset.section).scrollIntoViewIfNeeded();
        await page.locator(SEL.preset.selectorTrigger).click();
        const listbox = page.locator(SEL.preset.selectorListbox);
        await expect(listbox).toBeVisible({ timeout: T_MEDIUM });
        const t = await page.locator(SEL.preset.selectorTrigger).boundingBox();
        const l = await listbox.boundingBox();
        if (!t || !l) throw new Error("preset selector has no layout");
        // The popover is portaled below the trigger, so an element capture
        // drops the control it hangs off.
        await cap.snapBand(page, "settings/global/settings-preset-selector", {
          x: Math.min(t.x, l.x) - 10,
          y: t.y - 26,
          width: Math.max(t.width, l.width) + 20,
          height: l.y + l.height - t.y + 36,
        });
        await page.keyboard.press("Escape");
      });

      // ----------------------------------------------------------------------
      // Code Forge General. One capture, two slugs — the two docs pages ask
      // for the same panel, and the second only adds the audit-log heading
      // below the routing table, which this frame includes.
      // ----------------------------------------------------------------------
      const forgeShot = async (slug: string) => {
        await page.locator(tab("code-forge")).click();
        // The tab defaults to the first *provider* subtab, not General, when
        // nothing is stored — which is how the shipped capture ended up being
        // a photograph of the GitHub credential form.
        await page.locator('[data-testid="forge-provider-selector-trigger"]').click();
        await page.locator("#forge-provider-selector-item-general").click();
        await expect(page.locator("#forge-default-provider")).toBeVisible({ timeout: T_MEDIUM });
        await expect(page.locator("#forge-active-project-routing")).toBeVisible();
        const a = await page.locator("#forge-default-provider").boundingBox();
        // getByText, not a CSS list: `text=` is a Playwright engine prefix and
        // cannot appear inside a comma-separated CSS selector.
        const h = await page
          .getByText("Forge audit log", { exact: false })
          .first()
          .boundingBox()
          .catch(() => null);
        if (!a) throw new Error("forge general has no layout");
        await cap.snapBand(page, slug, {
          x: a.x - 12,
          y: a.y - 12,
          width: a.width + 24,
          height: h ? h.y + 28 - a.y : 460,
        });
      };
      await cap.shot("settings/global/settings-codeforge-general", () =>
        forgeShot("settings/global/settings-codeforge-general")
      );
      await cap.shot("code-forge/connect-and-authenticate/code-forge-general-routing", () =>
        forgeShot("code-forge/connect-and-authenticate/code-forge-general-routing")
      );

      // ----------------------------------------------------------------------
      // Project scope.
      // ----------------------------------------------------------------------
      await setScope(page, "Project");

      await cap.shot("settings/project/settings-override-field", async () => {
        await page.locator(tab("project:automation")).click();
        const section = page.locator("#project-terminal-settings");
        // Scroll first, hover second: a hover then a scroll drops the pointer.
        await section.scrollIntoViewIfNeeded();
        await page.waitForTimeout(T_SHORT);
        const field = section.locator("div.group", { hasText: "Shell program" }).first();
        await expect(field.locator('[data-testid="override-indicator"]')).toBeVisible({
          timeout: T_MEDIUM,
        });
        // Hover the label, not the input. Focusing the input paints the
        // accent-green focus ring over the blue override rim, which is the
        // one thing this shot exists to show.
        await field.locator('label:has-text("Shell program")').hover();
        await page.waitForTimeout(300);
        await expect(field.locator('[aria-label="Reset to global"]')).toBeVisible();
        // pad > 0 keeps the clip path, which never scrolls — an unpadded
        // element capture would scroll and drop the hover.
        await cap.snapElement(page, field, "settings/project/settings-override-field", 14);
      });

      await cap.shot("settings/project/settings-project-variables", async () => {
        await page.locator(tab("project:variables")).click();
        await expect(page.locator('h3:has-text("Inherited (Global)")')).toBeVisible({
          timeout: T_MEDIUM,
        });
        await expect(page.locator("text=Overridden").first()).toBeVisible();
        await cap.snapElement(
          page,
          page.locator("#project-env-vars"),
          "settings/project/settings-project-variables",
          12
        );
      });

      await cap.shot("projects/daintree-directory/projects-in-repo-settings-toggle", async () => {
        await page.locator(tab("project:general")).click();
        const sec = page.locator("#project-in-repo-settings");
        await sec.scrollIntoViewIfNeeded();
        await sec.locator('[aria-label="Store settings in repository"]').click();
        // The switch stays OFF while the panel is open: clicking it only
        // expands the confirmation. Confirming is what flips it.
        await expect(page.locator("text=The following files will be created:")).toBeVisible({
          timeout: T_MEDIUM,
        });
        // Gate on the panel's *last* element, not its first. The section's box
        // grows the moment the panel mounts, so a capture taken on the heading
        // alone clips a correctly-sized region over content that has not
        // painted yet — which is how this shipped as a blank panel.
        const confirm = page.getByRole("button", { name: "Confirm and enable" });
        await expect(confirm).toBeVisible({ timeout: T_MEDIUM });
        // Band the section rather than element-capturing it: the element box
        // can extend past the settings panel's scroll viewport, and the pixels
        // beyond it never render — which is how this first shipped as a black
        // rectangle. At DOCS_WINDOW_TALL the whole section fits, so anchor on
        // the heading and run to the panel's last control.
        await sec.scrollIntoViewIfNeeded();
        await page.waitForTimeout(T_SHORT);
        const cb = await confirm.boundingBox();
        const secBox = await sec.boundingBox();
        if (!cb || !secBox) throw new Error("in-repo section has no layout");
        const top = Math.max(0, secBox.y - 12);
        await cap.snapBand(page, "projects/daintree-directory/projects-in-repo-settings-toggle", {
          x: secBox.x - 10,
          y: top,
          width: secBox.width + 20,
          height: cb.y + cb.height + 16 - top,
        });
        // Cancel: confirming writes .daintree files into the fixture repo and
        // dirties the tree for anything that reads git state afterwards.
        await page.getByRole("button", { name: "Cancel" }).first().click().catch(() => {});
      });

      // ----------------------------------------------------------------------
      // Accent contrast. Last, because the override is global and would tint
      // every frame captured after it.
      // ----------------------------------------------------------------------
      await setScope(page, "Global");

      await cap.shot("themes/choosing-and-customizing/themes-accent-low-contrast", async () => {
        await page.locator(tab("terminalAppearance")).click();
        await page.locator(subtab("app")).click();
        const swatch = page.locator(SEL.settings.accentColorInput);
        await swatch.scrollIntoViewIfNeeded();
        // #3a3a38 clears the foreground gate comfortably and fails the surface
        // gate hard, so the warning names the surfaces rather than the button
        // text. fill() on <input type="color"> opens the OS picker; dispatch
        // the events instead.
        await swatch.evaluate((el) => {
          const input = el as HTMLInputElement;
          input.value = "#3a3a38";
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
        });
        const warning = page.locator(SEL.settings.accentContrastWarning);
        await expect(warning).toBeVisible({ timeout: T_MEDIUM });
        const s = await page.locator('section[aria-label="Accent color"]').boundingBox();
        const w = await warning.boundingBox();
        if (!s || !w) throw new Error("accent section has no layout");
        await cap.snapBand(page, "themes/choosing-and-customizing/themes-accent-low-contrast", {
          x: s.x - 10,
          y: s.y - 10,
          width: s.width + 20,
          height: w.y + w.height - s.y + 20,
        });
        // Mandatory: the override persists and would grey every later accent.
        await page.locator(SEL.settings.accentColorReset).click();
        await expect(warning).not.toBeVisible({ timeout: T_MEDIUM });
      });

      await resetOverlays(page);
    } finally {
      if (ctx) await closeApp(ctx.app).catch(() => {});
      repo.cleanup();
    }
  });
});
