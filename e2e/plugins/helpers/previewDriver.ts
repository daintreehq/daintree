import { expect, type ElectronApplication, type Page } from "@playwright/test";
import { createServer } from "net";
import type { AppContext } from "../../helpers/launch";
import { SEL } from "../../helpers/selectors";

/**
 * Driving a dev preview's page from a spec. Every helper here reaches the page
 * through main, because the host renderer's Trusted Types policy rejects
 * `webview.executeJavaScript`, and finds it by the marker every fixture site
 * puts on its `<body>`, so nothing ever reaches into another webview.
 */

export const SITE_MARKER_ATTRIBUTE = "data-daintree-e2e-site";

const SITE_MARKER = `!!document.body?.hasAttribute('${SITE_MARKER_ATTRIBUTE}')`;

/** A cold dev server compiles the framework before the first byte. */
export const DEV_SERVER_TIMEOUT = 120_000;

export async function freePort(): Promise<number> {
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

export async function dispatch(page: Page, actionId: string, args?: unknown) {
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

/** Evaluate in the dev preview's page, from main; null while no fixture page answers. */
export async function inPreview<T>(
  app: ElectronApplication,
  expression: string
): Promise<T | null> {
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
export async function pressInPreview(
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
export async function clickInPreview(
  { app, window }: Pick<AppContext, "app" | "window">,
  selector: string
): Promise<void> {
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

/** The dev preview panel with the Element Picker switched on: its strip and drawer. */
export function inspector(page: Page) {
  return page
    .locator(SEL.panel.gridPanel)
    .filter({ has: page.getByRole("toolbar", { name: "Element Picker" }) });
}

/** The drawer's identity block: what was selected and where it is written. */
export function selectedElement(page: Page) {
  return page
    .getByRole("complementary", { name: "Element Picker details" })
    .getByRole("region", { name: "Selected element" });
}

/**
 * Select an element the way a person does: click it, and click again until the
 * selection names `expected`. A dev server reloads the page once after
 * optimising dependencies and a framework hydrates after load; either can
 * swallow a click that lands in the gap while the strip already reads Select.
 */
export async function selectInPreview(
  ctx: Pick<AppContext, "app" | "window">,
  selector: string,
  expected: string | RegExp,
  timeout = 30_000
): Promise<void> {
  const selected = selectedElement(ctx.window);
  const matches = (text: string) =>
    typeof expected === "string" ? text.includes(expected) : expected.test(text);
  await expect
    .poll(
      async () => {
        await clickInPreview(ctx, selector);
        return matches(await selected.textContent({ timeout: 2000 }).catch(() => ""));
      },
      { timeout, intervals: [1000], message: `selecting ${selector} never showed ${expected}` }
    )
    .toBe(true);
}

/**
 * Collect the preview's own warnings and errors from creation: a page that
 * loads but never hydrates says why only there.
 */
export async function capturePreviewConsole(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ app }) => {
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
}

export async function previewConsole(app: ElectronApplication): Promise<string[]> {
  return app
    .evaluate(
      () => (globalThis as unknown as { __previewConsole?: string[] }).__previewConsole ?? []
    )
    .catch(() => ["<preview console unreadable>"]);
}

/** The picker panel's visible text, without the pane chrome around it. */
export async function inspectorText(page: Page): Promise<string> {
  return inspector(page)
    .first()
    .evaluate((element) => {
      const clone = element.cloneNode(true) as HTMLElement;
      clone.querySelector("[data-pane-chrome]")?.remove();
      return clone.innerText;
    })
    .catch(() => "<no inspector panel>");
}
