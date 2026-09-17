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
import {
  CARD_FILE,
  createSvelteKitProject,
  PAGE_FILE,
  PAGE_SOURCE,
} from "./helpers/sveltekitProject";
import { installSiteAgent } from "./helpers/siteAgent";

const PLUGIN_ID = "daintree.sveltekit-builder";
const TOGGLE_ACTION = `${PLUGIN_ID}.toggle-builder`;
const TOGGLE_TITLE = "Toggle Site Builder";
const HEADING_CLASSES = 'class="text-4xl font-bold"';
const AGENT_CLASSES = "bg-indigo-600 text-white";

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

/** Marks the fixture site's pages, so helpers never reach into another webview. */
const SITE_MARKER = "!!document.body?.hasAttribute('data-daintree-e2e-site')";

/**
 * Evaluate in the dev preview's page, from main: the host renderer's Trusted
 * Types policy rejects `webview.executeJavaScript`.
 */
async function inPreview<T>(app: ElectronApplication, expression: string): Promise<T | null> {
  return app.evaluate(
    async ({ webContents }, { source, marker }) => {
      for (const guest of webContents.getAllWebContents()) {
        if (guest.getType() !== "webview") continue;
        if (!(await guest.executeJavaScript(marker).catch(() => false))) continue;
        const value = await guest.executeJavaScript(source).catch(() => null);
        if (value !== null && value !== undefined) return value;
      }
      return null;
    },
    { source: expression, marker: SITE_MARKER }
  ) as Promise<T | null>;
}

/**
 * Press a key inside the preview as native input. Playwright's keyboard goes to
 * the host window and only sometimes crosses into a focused <webview>.
 */
async function pressInPreview(
  app: ElectronApplication,
  keyCode: string,
  modifiers: Array<"alt" | "shift" | "control" | "meta"> = []
): Promise<void> {
  const pressed = await app.evaluate(
    async ({ webContents }, input) => {
      let count = 0;
      for (const guest of webContents.getAllWebContents()) {
        if (guest.getType() !== "webview") continue;
        if (!(await guest.executeJavaScript(input.marker).catch(() => false))) continue;
        guest.sendInputEvent({
          type: "keyDown",
          keyCode: input.keyCode,
          modifiers: input.modifiers,
        });
        guest.sendInputEvent({ type: "keyUp", keyCode: input.keyCode, modifiers: input.modifiers });
        count += 1;
      }
      return count;
    },
    { keyCode, modifiers, marker: SITE_MARKER }
  );
  if (pressed !== 1)
    throw new Error(`expected one site preview to press keys in, found ${pressed}`);
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

/** The dev preview panel with the Site Builder switched on: its strip and drawer. */
function inspector(page: Page) {
  return page
    .locator(SEL.panel.gridPanel)
    .filter({ has: page.getByRole("toolbar", { name: "Site Builder" }) });
}

/**
 * The SvelteKit Site Builder against a real SvelteKit 2 / Svelte 5 / Tailwind 4
 * dev server, through the real app: enable the built-in, switch it on from the
 * plugin tray so it starts the site in a dev preview, toggle it from the
 * preview's own toolbar, point at an element, edit its classes on disk, undo,
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

  test("enabling the built-in registers its command", async () => {
    const { window } = ctx;
    await window.evaluate((id) => window.electron.plugin.setEnabled(id, true), PLUGIN_ID);
    await expect
      .poll(
        async () =>
          (await window.evaluate(() => window.electron.plugin.getActions())).map(
            (action) => action.id
          ),
        { timeout: PLUGIN_TIMEOUT }
      )
      .toContain(TOGGLE_ACTION);
    // It lives in the dev preview now, not in a panel of its own.
    const kinds = await window.evaluate(() => window.electron.plugin.getPanelKinds());
    expect(kinds.map((kind) => kind.id).filter((id) => id.startsWith(PLUGIN_ID))).toEqual([]);
  });

  test("the plugin tray switches the Site Builder on, starting the site in a dev preview", async () => {
    const { window } = ctx;
    const port = await freePort();
    await saveCurrentProjectSettings(window, {
      devServerCommand: `npm run dev -- --host 127.0.0.1 --port ${port} --strictPort`,
    });
    await expect(window.locator("webview")).toHaveCount(0);

    await window.getByRole("button", { name: "Plugin tray" }).click();
    await window.getByRole("menuitem", { name: TOGGLE_TITLE }).click();

    // Toggling a tool uses none of the plugin's capabilities, so no confirm.
    await expect(window.getByRole("dialog", { name: `Run '${TOGGLE_TITLE}'?` })).toHaveCount(0);
    const strip = window.getByRole("toolbar", { name: "Site Builder" });
    await expect(strip).toBeVisible({ timeout: PLUGIN_TIMEOUT });
    await expect(window.locator("webview")).toBeAttached({ timeout: DEV_SERVER_TIMEOUT });
    await expect(strip.getByText("Click any element on the page")).toBeVisible({
      timeout: DEV_SERVER_TIMEOUT,
    });
  });

  test("the dev preview's own toolbar button toggles the Site Builder", async () => {
    const { window } = ctx;
    const strip = window.getByRole("toolbar", { name: "Site Builder" });
    await strip.getByRole("button", { name: "Close Site Builder" }).click();
    await expect(strip).toHaveCount(0);

    const toggle = window.getByRole("button", { name: "Site Builder", exact: true });
    await expect(toggle).toHaveAttribute("aria-pressed", "false", { timeout: PLUGIN_TIMEOUT });
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await expect(strip.getByText("Click any element on the page")).toBeVisible({
      timeout: PLUGIN_TIMEOUT,
    });
    await expect(strip.getByRole("button", { name: "Select" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
  });

  test("clicking an element in the preview traces it to its source", async () => {
    const { window } = ctx;
    const panel = inspector(window);
    await selectInPreview(window, "h1");

    await expect(window.getByRole("toolbar", { name: "Site Builder" })).toContainText(
      `${PAGE_FILE}:2`
    );
    const details = window.getByRole("complementary", { name: "Site Builder details" });
    await expect(details).toBeVisible();
    // Open by default; opened here only if a remembered preference folded it.
    const edits = panel.getByRole("button", { name: "Edit directly" });
    if ((await edits.getAttribute("aria-expanded")) !== "true") await edits.click();
    await expect(panel.getByRole("list", { name: "Classes" })).toContainText("text-4xl");
  });

  test("Option+Up selects the component that drew an element", async () => {
    const { window } = ctx;
    const strip = window.getByRole("toolbar", { name: "Site Builder" });
    await clickInPreview(ctx, "article h2");
    await expect(strip).toContainText(`${CARD_FILE}:6`, { timeout: PLUGIN_TIMEOUT });

    await pressInPreview(ctx.app, "Up", ["alt"]);
    await expect(strip).toContainText("FeatureCard", { timeout: PLUGIN_TIMEOUT });
    await expect(strip.getByText("Component", { exact: true })).toBeVisible();
    const scope = window
      .getByRole("group", { name: "What the request is about" })
      .getByRole("button", { name: "FeatureCard" });
    await expect(scope).toHaveAttribute("aria-pressed", "true");
    await window.screenshot({ path: test.info().outputPath("component-selected.png") });

    // Back to the heading for the edit steps.
    await selectInPreview(window, "h1");
    await window.screenshot({ path: test.info().outputPath("element-selected.png") });
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

  test("a new Claude session restyles the selected component on the live page", async () => {
    const { window, app } = ctx;
    const panel = inspector(window);
    const strip = window.getByRole("toolbar", { name: "Site Builder" });
    // Every card's computed background, or null when the page isn't there to ask.
    const cardBackgrounds = () =>
      inPreview<string[]>(
        app,
        `(() => { const cards = [...document.querySelectorAll("article")]; return cards.length ? cards.map((card) => getComputedStyle(card).backgroundColor) : null; })()`
      );
    const before = await cardBackgrounds();
    expect(before).toHaveLength(3);

    // Pick the FeatureCard component, the way a user would.
    await clickInPreview(ctx, "article h2");
    await expect(strip).toContainText(`${CARD_FILE}:6`, { timeout: PLUGIN_TIMEOUT });
    await pressInPreview(app, "Up", ["alt"]);
    await expect(strip.getByText("Component", { exact: true })).toBeVisible({
      timeout: PLUGIN_TIMEOUT,
    });

    // No agent is running: the composer offers the user's own CLIs.
    const destination = panel.getByRole("combobox", { name: "Agent to send to" });
    await expect(destination).toContainText("New Claude", { timeout: PLUGIN_TIMEOUT });

    const panelsBefore = new Set(await getGridPanelIds(window));
    const request = panel.getByRole("textbox", { name: "Request for the agent" });
    await request.fill(`Add the classes "${AGENT_CLASSES}" to it`);
    await window.screenshot({ path: test.info().outputPath("composer.png") });
    await panel.getByRole("button", { name: "Send to agent" }).click();

    await expect
      .poll(
        async () => {
          agentPanelId = (await getGridPanelIds(window)).find((id) => !panelsBefore.has(id)) ?? "";
          return agentPanelId;
        },
        { timeout: PLUGIN_TIMEOUT }
      )
      .not.toBe("");

    // A fresh Claude asks whether to trust the folder. The request must wait for
    // that answer rather than be typed into the question.
    await expect
      .poll(
        () =>
          existsSync(`${agentInbox}.raw`) &&
          readFileSync(`${agentInbox}.raw`, "utf8").includes("started"),
        { timeout: 60_000 }
      )
      .toBe(true);
    await window.waitForTimeout(1500);
    expect(existsSync(agentInbox)).toBe(false);
    await ptyWrite(window, agentPanelId, "\r");

    await expect
      .poll(() => readFileSync(path.join(projectDir, ...CARD_FILE.split("/")), "utf8"), {
        timeout: 90_000,
      })
      .toContain(`p-5 shadow-sm ${AGENT_CLASSES}`);
    const received = readFileSync(agentInbox, "utf8");
    expect(received).toContain("- Target: the FeatureCard component");
    expect(received).toContain(`Source: <article> at ${CARD_FILE}:5:1`);
    // Line breaks survive: the request went in as typed input, not a shell argument.
    expect(received).toContain("```svelte\n");
    await expect(panel.getByRole("status").filter({ hasText: /Sent to/ })).toBeVisible({
      timeout: PLUGIN_TIMEOUT,
    });

    // Every card on the running site picks up the new look, with no reload.
    await expect
      .poll(
        async () => {
          const after = await cardBackgrounds();
          // All three cards still rendered, and every one of them restyled.
          return (
            after !== null &&
            after.length === 3 &&
            after.every((color, index) => color !== before![index])
          );
        },
        { timeout: PLUGIN_TIMEOUT }
      )
      .toBe(true);
    await window.screenshot({ path: test.info().outputPath("agent-done.png") });
  });
});
