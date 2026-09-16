import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { existsSync, readFileSync } from "fs";
import path from "path";
import { createServer } from "net";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { saveCurrentProjectSettings } from "../helpers/projectSettings";
import { getGridPanelIds } from "../helpers/panels";
import { fakeAgentEnv, ptyWrite } from "../helpers/fakeAgent";
import { SEL } from "../helpers/selectors";
import { T_MEDIUM } from "../helpers/timeouts";
import { createSvelteKitProject, PAGE_FILE, PAGE_SOURCE } from "./helpers/sveltekitProject";
import { installSiteAgent } from "./helpers/siteAgent";

const PLUGIN_ID = "daintree.sveltekit-builder";
const PANEL_KIND = `${PLUGIN_ID}.inspector`;
const OPEN_ACTION = `${PLUGIN_ID}.open-inspector`;
const OPEN_TITLE = "Open Site Builder";
const HEADING_CLASSES = 'class="text-4xl font-bold"';
const AGENT_HEADING = "Built by an agent";

// A cold Vite start compiles SvelteKit and Tailwind before the first byte.
const DEV_SERVER_TIMEOUT = 120_000;
const PLUGIN_TIMEOUT = 30_000;

let ctx: AppContext;
let projectDir: string;
let agentInbox: string;
let agentPanelId = "";
let cleanup: (() => void) | undefined;
const rendererConsole: string[] = [];

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function dispatch(page: Page, actionId: string, args?: unknown) {
  return page.evaluate(
    async (payload) => {
      const run = (
        window as unknown as {
          __daintreeDispatchAction?: (
            id: string,
            args?: unknown,
            options?: { source: string }
          ) => Promise<{ ok: boolean; error?: unknown }>;
        }
      ).__daintreeDispatchAction;
      if (typeof run !== "function") throw new Error("__daintreeDispatchAction is not available");
      return run(payload.actionId, payload.args, { source: "user" });
    },
    { actionId, args }
  );
}

/**
 * Evaluate in the dev preview's page, from main: the host renderer's Trusted
 * Types policy rejects `webview.executeJavaScript`.
 */
async function inPreview<T>(app: ElectronApplication, expression: string): Promise<T | null> {
  return app.evaluate(async ({ webContents }, source) => {
    for (const guest of webContents.getAllWebContents()) {
      if (guest.getType() !== "webview") continue;
      const value = await guest.executeJavaScript(source).catch(() => null);
      if (value !== null && value !== undefined) return value;
    }
    return null;
  }, expression) as Promise<T | null>;
}

type Rect = { x: number; y: number; width: number; height: number };

/** Click an element inside the preview at its real on-screen position. */
async function clickInPreview({ app, window }: AppContext, selector: string): Promise<void> {
  let rect: Rect | null = null;
  await expect
    .poll(
      async () => {
        rect = await inPreview<Rect>(
          app,
          `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`
        );
        return rect !== null;
      },
      { timeout: DEV_SERVER_TIMEOUT }
    )
    .toBe(true);
  const frame = await window.locator("webview").boundingBox();
  expect(frame).not.toBeNull();
  const target = rect as unknown as Rect;
  await window.mouse.click(
    frame!.x + target.x + Math.min(target.width / 2, 40),
    frame!.y + target.y + target.height / 2
  );
}

/**
 * Select an element the way a person does: click it, and click again if the
 * page wasn't listening yet. Vite reloads the page once after optimising
 * dependencies, and a grid change recreates it; either reinstalls the page
 * runtime, so a click can land in the gap while the panel already reads Select.
 */
async function selectInPreview(page: Page, selector: string): Promise<void> {
  const panel = inspector(page);
  const selected = panel.getByRole("region", { name: "Selected element" });
  await expect
    .poll(
      async () => {
        await clickInPreview(ctx, selector);
        return selected.textContent({ timeout: 2000 }).catch(() => "");
      },
      { timeout: PLUGIN_TIMEOUT, intervals: [1000] }
    )
    .toContain(`${PAGE_FILE}:2`);
}

const readPage = () => readFileSync(path.join(projectDir, ...PAGE_FILE.split("/")), "utf8");

function inspector(page: Page) {
  return page.locator(SEL.panel.gridPanel).filter({ hasText: "Site Builder" });
}

/**
 * The SvelteKit Site Builder against a real SvelteKit 2 / Svelte 5 / Tailwind 4
 * dev server, through the real app: enable the built-in, find its panel, open
 * it from the plugin tray and let it start the site, point at an element, edit its classes on disk, undo,
 * then hand the element to an agent terminal and watch the site change.
 *
 * Every step is its own test in a serial block, so a failure names the first
 * link in the chain that broke instead of timing out at the end.
 */
test.describe.serial("Plugin: SvelteKit Site Builder", () => {
  test.beforeAll(async () => {
    ({ dir: projectDir, cleanup } = createSvelteKitProject("sveltekit-builder"));
    const agent = installSiteAgent(projectDir);
    agentInbox = agent.inbox;
    ctx = await launchApp({ env: fakeAgentEnv(agent.binDir) });

    // The preview's own console, collected from creation: a page that loads
    // but never hydrates says why only here.
    await ctx.app.evaluate(({ app }) => {
      const scope = globalThis as unknown as { __previewConsole?: string[] };
      scope.__previewConsole = [];
      app.on("web-contents-created", (_event, contents) => {
        if (contents.getType() !== "webview") return;
        contents.on("console-message", (event) => {
          const detail = event as unknown as { level?: string; message?: string };
          if (detail.level === "error" || detail.level === "warning") {
            scope.__previewConsole!.push(`[${detail.level}] ${detail.message}`);
          }
        });
      });
    });

    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, projectDir, "SvelteKit site");
    ctx.window.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning") {
        rendererConsole.push(`[${message.type()}] ${message.text()}`);
      }
    });
    ctx.window.on("pageerror", (error) => rendererConsole.push(`[pageerror] ${error.stack}`));
  });

  test.afterEach(async () => {
    const testInfo = test.info();
    if (testInfo.status === testInfo.expectedStatus) return;
    const panel = await inspector(ctx.window)
      .first()
      .evaluate((element) => {
        const clone = element.cloneNode(true) as HTMLElement;
        clone.querySelector("[data-pane-chrome]")?.remove();
        return clone.innerText;
      })
      .catch(() => "<no inspector panel>");
    const preview = await ctx.app.evaluate(
      () => (globalThis as unknown as { __previewConsole?: string[] }).__previewConsole ?? []
    );
    const agentScreen = agentPanelId
      ? await ctx.window
          .evaluate((id) => {
            const read = (window as unknown as Record<string, unknown>)
              .__daintreeReadTerminalBuffer;
            return typeof read === "function" ? String(read(id)) : "<no reader>";
          }, agentPanelId)
          .catch(() => "<unreadable>")
      : "<no agent>";
    const report = [
      `--- agent terminal ---\n${agentScreen.slice(-3000)}`,
      `--- inspector ---\n${panel}`,
      `--- renderer console ---\n${rendererConsole.join("\n")}`,
      `--- preview console ---\n${preview.join("\n")}`,
      `--- agent inbox ---\n${existsSync(agentInbox) ? readFileSync(agentInbox, "utf8") : "<empty>"}`,
      `--- agent raw input ---\n${existsSync(`${agentInbox}.raw`) ? readFileSync(`${agentInbox}.raw`, "utf8").slice(0, 4000) : "<empty>"}`,
    ].join("\n");
    await testInfo.attach("diagnostics", { body: report });
    console.log(report);
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    cleanup?.();
  });

  test("enabling the built-in registers its panel and command", async () => {
    const { window } = ctx;
    await window.evaluate((id) => window.electron.plugin.setEnabled(id, true), PLUGIN_ID);

    await expect
      .poll(
        async () =>
          (await window.evaluate(() => window.electron.plugin.getPanelKinds())).map(
            (kind) => kind.id
          ),
        { timeout: PLUGIN_TIMEOUT }
      )
      .toContain(PANEL_KIND);
    await expect
      .poll(
        async () =>
          (await window.evaluate(() => window.electron.plugin.getActions())).map(
            (action) => action.id
          ),
        { timeout: PLUGIN_TIMEOUT }
      )
      .toContain(OPEN_ACTION);
  });

  test("the panel palette offers the Site Builder", async () => {
    const { window } = ctx;
    await dispatch(window, "panel.palette");
    const palette = window.locator(SEL.panelPalette.dialog);
    await expect(palette).toBeVisible({ timeout: T_MEDIUM });
    await window.locator(SEL.panelPalette.searchInput).fill("Site Builder");
    await expect(
      window.locator(SEL.panelPalette.options).filter({ hasText: "Site Builder" })
    ).toBeVisible({ timeout: T_MEDIUM });
    await window.keyboard.press("Escape");
    await expect(palette).not.toBeVisible({ timeout: T_MEDIUM });
  });

  test("the plugin tray opens the Site Builder, which starts the site itself", async () => {
    const { window } = ctx;
    const port = await freePort();
    await saveCurrentProjectSettings(window, {
      devServerCommand: `npm run dev -- --host 127.0.0.1 --port ${port} --strictPort`,
    });
    // No preview is running: the Site Builder has to start one.
    await expect(window.locator("webview")).toHaveCount(0);

    await window.getByRole("button", { name: "Plugin tray" }).click();
    await window.getByRole("menuitem", { name: OPEN_TITLE }).click();

    // Opening a panel uses none of the plugin's capabilities, so no confirm.
    await expect(window.getByRole("dialog", { name: `Run '${OPEN_TITLE}'?` })).toHaveCount(0);
    const panel = inspector(window);
    await expect(panel).toBeVisible({ timeout: PLUGIN_TIMEOUT });
    await expect(panel.getByRole("button", { name: "Start selecting" })).toBeVisible({
      timeout: DEV_SERVER_TIMEOUT,
    });
    await expect(window.locator("webview")).toBeAttached();
  });

  test("clicking an element in the preview traces it to its source", async () => {
    const { window } = ctx;
    const panel = inspector(window);
    await panel.getByRole("button", { name: "Start selecting" }).click();
    await expect(panel.getByText("Click an element in the preview to select it")).toBeVisible({
      timeout: T_MEDIUM,
    });

    await selectInPreview(window, "h1");

    const selected = panel.getByRole("region", { name: "Selected element" });
    await expect(selected.getByRole("list", { name: "Classes" })).toContainText("text-4xl");
  });

  test("adding a class writes it to the component source", async () => {
    const { window } = ctx;
    const panel = inspector(window);
    const input = panel.getByRole("combobox", { name: "Add a class" });
    await input.fill("underline");
    await input.press("Enter");

    await expect
      .poll(readPage, { timeout: PLUGIN_TIMEOUT })
      .toBe(PAGE_SOURCE.replace(HEADING_CLASSES, 'class="text-4xl font-bold underline"'));
    await expect(panel.getByRole("region", { name: "Last change" })).toBeVisible({
      timeout: T_MEDIUM,
    });
  });

  test("undo restores the original bytes", async () => {
    const { window } = ctx;
    const panel = inspector(window);
    await panel.getByRole("button", { name: "Undo" }).click();
    await expect.poll(readPage, { timeout: PLUGIN_TIMEOUT }).toBe(PAGE_SOURCE);
  });

  test("an agent in the worktree takes the selected element and changes the site", async () => {
    const { window, app } = ctx;

    const before = new Set(await getGridPanelIds(window));
    const launched = await dispatch(window, "agent.launch", { agentId: "claude" });
    expect(launched.ok, JSON.stringify(launched.error)).toBe(true);
    await expect
      .poll(
        async () => {
          agentPanelId = (await getGridPanelIds(window)).find((id) => !before.has(id)) ?? "";
          return agentPanelId;
        },
        { timeout: PLUGIN_TIMEOUT }
      )
      .not.toBe("");
    const agentPanel = window.locator(`[data-panel-id="${agentPanelId}"]`);
    // Past the workspace trust prompt, then wait until Daintree sees an agent.
    await expect
      .poll(
        async () => {
          await ptyWrite(window, agentPanelId, "\r");
          return agentPanel.getAttribute("data-detected-agent-id");
        },
        { timeout: 60_000, intervals: [1000] }
      )
      .toBe("claude");

    // Opening the agent re-lays the grid, which recreates the preview's page;
    // the inspector reattaches on its own.
    const panel = inspector(window);
    await expect(panel.getByText("Click an element in the preview to select it")).toBeVisible({
      timeout: PLUGIN_TIMEOUT,
    });
    await selectInPreview(window, "h1");

    const request = panel.getByRole("textbox", { name: "Request for the agent" });
    await expect(request).toBeEnabled({ timeout: PLUGIN_TIMEOUT });
    await request.fill(`Change the text to "${AGENT_HEADING}"`);
    await panel.getByRole("button", { name: "Send to agent" }).click();
    await expect(panel.getByRole("status").filter({ hasText: /^Sent to/ })).toBeVisible({
      timeout: PLUGIN_TIMEOUT,
    });

    await expect
      .poll(readPage, { timeout: PLUGIN_TIMEOUT })
      .toBe(PAGE_SOURCE.replace("Daintree site builder", AGENT_HEADING));
    await expect(readFileSync(agentInbox, "utf8")).toContain(`Source: <h1> at ${PAGE_FILE}:2:3`);

    // The running site picks the edit up, with no reload from the test.
    await expect
      .poll(() => inPreview<string>(app, `document.querySelector("h1")?.textContent ?? null`), {
        timeout: PLUGIN_TIMEOUT,
      })
      .toBe(AGENT_HEADING);
  });
});
