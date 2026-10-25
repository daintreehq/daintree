/**
 * Canopy on its local model, end to end: the real app, real PTYs, fake Claude
 * agents drawing realistic screens, and the published reader downloaded from
 * Hugging Face and run in its own process. Turning Canopy on downloads the
 * Light model and every row is read on this machine; Settings lists the
 * models and switching to Best downloads it and deletes Light; turning Canopy
 * off lets the reader process go.
 *
 * Opt-in only, since it downloads the models (about 90 MB):
 *
 *   DAINTREE_E2E_CANOPY_LOCAL=1 npx playwright test --project=full-panels canopy-local-reader
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import { execSync } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { getGridPanelIds, openSettings } from "../../helpers/panels";
import { SEL } from "../../helpers/selectors";
import { T_LONG, T_MEDIUM, T_SHORT } from "../../helpers/timeouts";
import { dismissBlockingPalette } from "../../helpers/overlays";
import { fakeAgentEnv } from "../../helpers/fakeAgent";
import {
  installFakeCanopyAgent,
  setFakeCanopyScene,
  type FakeCanopyScene,
} from "../../helpers/fakeCanopyAgent";

const ENABLED = !!process.env.DAINTREE_E2E_CANOPY_LOCAL;

const HEADER = [
  "▐▛███▜▌   Claude Code v9.9.9",
  "▝▜█████▛▘  Opus · Claude Max",
  "  ▘▘ ▝▝    ~/code/recipes",
  "",
];

const FINISHED: FakeCanopyScene = {
  lines: [
    ...HEADER,
    "> Fix the rounding in scaleRecipe and run the tests",
    "",
    "⏺ Fixed the rounding: amounts are scaled before they are rounded.",
    "",
    "⏺ Bash(npm test)",
    "  ⎿  ✓ 14 passed",
    "",
    "⏺ All 14 tests pass. The change is not committed yet.",
    "",
    "✻ Worked for 41s · done",
  ],
};

const APPROVAL: FakeCanopyScene = {
  box: false,
  lines: [
    ...HEADER,
    "> Clean up and commit",
    "",
    "⏺ Bash(rm -rf dist)",
    "",
    "╭──────────────────────────────────────────────────────────╮",
    "│ Bash command                                             │",
    "│                                                          │",
    "│   rm -rf dist                                            │",
    "│   Remove the stale build output                          │",
    "│                                                          │",
    "│ Do you want to proceed?                                  │",
    "│ ❯ 1. Yes                                                 │",
    "│   2. No, and tell Claude what to do differently (esc)    │",
    "╰──────────────────────────────────────────────────────────╯",
  ],
};

const QUESTION: FakeCanopyScene = {
  lines: [
    ...HEADER,
    "> Add a CHANGELOG entry for the units work, and ask me which date format to use first",
    "",
    "⏺ Which date format should the CHANGELOG entry use: 2026-10-08, or October 8, 2026?",
    "",
    "✻ Worked for 3s · done",
  ],
};

let ctx: AppContext;
let binDir: string;
let tracePath: string;
let cleanupFixture: (() => void) | undefined;
const agents = { finished: "", approval: "", question: "" };

const dialog = (page: Page) => page.locator('[data-testid="canopy-dialog"]');
const rows = (page: Page) => dialog(page).locator("[data-canopy-list] [data-canopy-card]");
const row = (page: Page, paneId: string) => dialog(page).locator(`#canopy-card-${paneId}`);
const toggleCanopy = (page: Page) =>
  page.keyboard.press(process.platform === "darwin" ? "Meta+E" : "Control+Shift+O");

async function launchClaude(page: Page): Promise<string> {
  const before = new Set(await getGridPanelIds(page));
  await dismissBlockingPalette(page);
  await page.locator(SEL.agent.trayButton).click();
  await page.locator(SEL.agent.launcherRow("Claude")).first().click();
  let id: string | undefined;
  await expect
    .poll(
      async () => {
        id = (await getGridPanelIds(page)).find((candidate) => !before.has(candidate));
        return id !== undefined;
      },
      { timeout: T_LONG, intervals: [250] }
    )
    .toBe(true);
  return id!;
}

async function openCanopySettings(page: Page): Promise<Locator> {
  await openSettings(page);
  await expect(page.locator(SEL.settings.heading)).toBeVisible({ timeout: T_MEDIUM });
  const tab = page.locator(`${SEL.settings.navSidebar} [id="settings-tab-canopy"]`);
  await tab.click();
  const panel = page.locator('[id="settings-panel-canopy"]');
  await expect(panel).toBeVisible({ timeout: T_SHORT });
  return panel;
}

function traceReads(): Array<{ stage: string; at: number; error?: string; output?: unknown }> {
  if (!existsSync(tracePath)) return [];
  return readFileSync(tracePath, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

function modelDir(name: string): string {
  return path.join(ctx.userDataDir, "canopy", "models", name);
}

/** The reader's utility processes, by the service name it is forked under, with their memory. */
async function readerProcesses(): Promise<Array<{ pid: number; workingSetKb: number | null }>> {
  const metrics = await ctx.app.evaluate(({ app }) =>
    app.getAppMetrics().map((metric) => ({
      pid: metric.pid,
      type: metric.type,
      name: metric.name ?? "",
      workingSetKb: (metric.memory as Electron.MemoryInfo | undefined)?.workingSetSize ?? null,
    }))
  );
  return metrics
    .filter((m) => m.type === "Utility" && m.name === "daintree-canopy-reader")
    .map(({ pid, workingSetKb }) => ({ pid, workingSetKb }));
}

const readerCount = async () => (await readerProcesses()).length;

test.describe("Canopy on its local model", () => {
  test.describe.configure({ mode: "serial" });
  test.beforeAll(async () => {
    if (!ENABLED) return;
    const { dir, cleanup } = createFixtureRepo({ name: "canopy-local" });
    cleanupFixture = cleanup;
    binDir = installFakeCanopyAgent(dir);
    writeFileSync(path.join(dir, ".gitignore"), ".e2e canopy bin/\n");
    execSync("git add -A && git commit -m canopy-fixture", { cwd: dir, stdio: "ignore" });
    tracePath = path.join(binDir, "trace.jsonl");
    ctx = await launchApp({ env: { ...fakeAgentEnv(binDir), DAINTREE_CANOPY_TRACE: tracePath } });
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, dir, "Canopy Local");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    cleanupFixture?.();
  });

  test("turning Canopy on downloads Light and reads every agent on this machine", async () => {
    test.info().annotations.push({
      type: "conditional-skip",
      description: "DAINTREE_E2E_CANOPY_LOCAL is required: the spec downloads the models",
    });
    test.skip(!ENABLED, "set DAINTREE_E2E_CANOPY_LOCAL=1 to download the models");
    test.setTimeout(300_000);
    const page = ctx.window;

    agents.finished = await launchClaude(page);
    agents.approval = await launchClaude(page);
    agents.question = await launchClaude(page);
    setFakeCanopyScene(binDir, agents.finished, FINISHED);
    setFakeCanopyScene(binDir, agents.approval, APPROVAL);
    setFakeCanopyScene(binDir, agents.question, QUESTION);
    for (const id of Object.values(agents)) {
      await expect(page.locator(`[data-panel-id="${id}"]`)).toHaveAttribute(
        "data-agent-state",
        "waiting",
        { timeout: 60_000 }
      );
    }
    // Nothing is fetched or started before Canopy is turned on.
    expect(existsSync(path.join(ctx.userDataDir, "canopy"))).toBe(false);
    expect(await readerCount()).toBe(0);

    await toggleCanopy(page);
    const offer = dialog(page);
    await expect(
      offer.getByText("Nothing it reads leaves this computer.", { exact: false })
    ).toBeVisible();
    await expect(offer.getByText("Privacy policy")).toHaveCount(0);
    await expect(offer.getByText("paid", { exact: false })).toHaveCount(0);
    await offer.getByRole("button", { name: "Turn on Canopy" }).click();

    await expect(rows(page)).toHaveCount(3, { timeout: 60_000 });
    // Every row read and ranked, with words copied off its screen.
    await expect
      .poll(
        async () =>
          rows(page).evaluateAll((all) =>
            all.every((r) => (r as HTMLElement).dataset.priority !== undefined)
          ),
        { timeout: 120_000, intervals: [500] }
      )
      .toBe(true);
    // Light reads in INT8 on ARM and in FP32 on x86, where its INT8 reads wrongly.
    const lightWeights = process.arch === "x64" ? "model.fp32.onnx" : "model.int8.onnx";
    expect(existsSync(path.join(modelDir("canopy-reader-17m"), lightWeights))).toBe(true);
    expect(existsSync(modelDir("canopy-reader-68m"))).toBe(false);
    const readers = await readerProcesses();
    expect(readers).toHaveLength(1);
    console.log(`Light reader process: ${readers[0]!.workingSetKb} KB working set`);

    await expect(row(page, agents.approval)).toContainText("Do you want to proceed?", {
      timeout: 30_000,
    });
    await expect(row(page, agents.question)).toContainText("Which date format", {
      timeout: 30_000,
    });
    await expect(row(page, agents.finished)).toContainText("tests pass", { timeout: 30_000 });
    await expect(dialog(page).locator("[data-canopy-status]")).toContainText(
      "Light model, on this computer"
    );

    const reads = traceReads().filter((read) => read.stage === "reader");
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.filter((read) => read.error === undefined).length).toBeGreaterThan(0);
    const categories = reads.flatMap((read) => {
      const out = read.output as { classifier?: { category?: string } } | undefined;
      return out?.classifier?.category ? [out.classifier.category] : [];
    });
    expect(categories).toContain("approval");
    console.log(
      "rows:\n" +
        (await rows(page).evaluateAll((all) =>
          all.map((r) => `  ${(r as HTMLElement).dataset.priority} ${r.textContent}`).join("\n")
        ))
    );
    await page.keyboard.press("Escape");
  });

  test("Settings lists both models honestly, and switching to Best downloads it and deletes Light", async () => {
    test.info().annotations.push({
      type: "conditional-skip",
      description: "DAINTREE_E2E_CANOPY_LOCAL is required: the spec downloads the models",
    });
    test.skip(!ENABLED, "set DAINTREE_E2E_CANOPY_LOCAL=1 to download the models");
    test.setTimeout(300_000);
    const page = ctx.window;
    const panel = await openCanopySettings(page);
    const light = panel.getByRole("radio", { name: /Light/ });
    const best = panel.getByRole("radio", { name: /Best/ });
    await expect(light).toBeVisible({ timeout: T_MEDIUM });
    await expect(best).toBeVisible();
    await expect(light).toHaveAttribute("aria-checked", "true");
    await expect(light).toContainText("Downloaded");
    await expect(panel).toContainText("Both read an agent's state equally well");
    await expect(panel.getByText("Plan", { exact: true })).toHaveCount(0);
    await expect(panel.getByText("Privacy policy")).toHaveCount(0);
    console.log("settings:\n" + (await panel.innerText()));

    const switchedAt = Date.now();
    await best.click();
    await expect(best).toHaveAttribute("aria-checked", "true");
    await expect(best).toContainText("Downloaded", { timeout: 240_000 });
    await expect
      .poll(() => existsSync(modelDir("canopy-reader-17m")), { timeout: 30_000 })
      .toBe(false);
    expect(existsSync(path.join(modelDir("canopy-reader-68m"), "model.int8.onnx"))).toBe(true);
    await page.keyboard.press("Escape");

    // Best reads the same agents.
    await toggleCanopy(page);
    await expect(dialog(page).locator("[data-canopy-status]")).toContainText(
      "Best model, on this computer",
      { timeout: 60_000 }
    );
    await expect(row(page, agents.approval)).toContainText("Do you want to proceed?", {
      timeout: 60_000,
    });
    const readers = await readerProcesses();
    expect(readers).toHaveLength(1);
    console.log(`Best reader process: ${readers[0]!.workingSetKb} KB working set`);
    // Fresh readings from Best, not the last model's left standing: every agent
    // read again after the switch, the approval among them.
    await expect
      .poll(
        () => {
          const since = traceReads().filter(
            (read) => read.stage === "reader" && read.at >= switchedAt && read.error === undefined
          );
          return since
            .map(
              (read) => (read.output as { classifier?: { category?: string } }).classifier?.category
            )
            .filter((c): c is string => c !== undefined)
            .sort();
        },
        { timeout: 60_000, intervals: [500] }
      )
      .toEqual(expect.arrayContaining(["approval", "finished", "question"]));
    await page.keyboard.press("Escape");
  });

  test("turning Canopy off lets the reader go, and its model can then be deleted", async () => {
    test.info().annotations.push({
      type: "conditional-skip",
      description: "DAINTREE_E2E_CANOPY_LOCAL is required: the spec downloads the models",
    });
    test.skip(!ENABLED, "set DAINTREE_E2E_CANOPY_LOCAL=1 to download the models");
    test.setTimeout(120_000);
    const page = ctx.window;
    const panel = await openCanopySettings(page);
    await panel.getByRole("switch", { name: "Read agent terminals" }).click();
    await expect.poll(readerCount, { timeout: 15_000 }).toBe(0);
    await panel.getByRole("button", { name: "Delete model" }).click();
    await expect
      .poll(() => existsSync(modelDir("canopy-reader-68m")), { timeout: 15_000 })
      .toBe(false);
    await expect(panel.getByRole("button", { name: "Delete model" })).toHaveCount(0);
  });
});
