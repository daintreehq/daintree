import { expect, type Locator, type Page } from "@playwright/test";
import { createServer, searchForWorkspaceRoot, type ViteDevServer } from "vite";
import { realpathSync } from "fs";
import path from "path";

/**
 * Shared plumbing for the standalone `*-preview.html` visual-review harnesses.
 *
 * Each of those pages renders one product surface from fixtures against the real
 * theme tokens and the real `index.css`, served by Vite rather than Electron. The
 * three things every such spec needs — a dev server on a free port, an inert HMR
 * client, and a screenshot helper that refuses to write an unverified frame —
 * are the same every time, so they live here.
 */

export interface PreviewServer {
  baseURL: string;
  close: () => Promise<void>;
}

/**
 * `strictPort: false` is load-bearing: the project's own `vite.config.ts` pins
 * `port: 5173` with `strictPort: true`, and that survives the merge with this
 * inline config — so beside a running `npm run dev` the harness would die on an
 * occupied port, surfacing as `element(s) not found` on whichever page load lost
 * the race. Walking to the next free port lets the capture run beside a live app.
 */
export async function startPreviewServer(): Promise<PreviewServer> {
  // Worktrees symlink `node_modules` to the main checkout, which puts the
  // fontsource woff2 files outside Vite's default allow list — the page then
  // renders in a fallback face and every type judgement is wrong. Allow the
  // real path as well as the workspace root.
  const fsAllow = [searchForWorkspaceRoot(process.cwd())];
  try {
    fsAllow.push(realpathSync(path.join(process.cwd(), "node_modules")));
  } catch {
    // no node_modules to resolve — Vite will say so itself
  }
  const server: ViteDevServer = await createServer({
    server: { port: 0, strictPort: false, fs: { allow: fsAllow } },
    logLevel: "error",
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("vite gave no TCP address");
  return {
    baseURL: `http://127.0.0.1:${address.port}`,
    close: () => server.close(),
  };
}

/**
 * Serve an inert `@vite/client` so no page in a sweep opens an HMR socket.
 *
 * A harness that navigates a few dozen times against one dev server goes blank
 * from roughly the twenty-second load onwards: Chromium throttles repeated
 * WebSocket handshakes to one host with an escalating delay, each navigation
 * tears the pending handshake down before it completes, the client eventually
 * falls into its `SharedWorker` recovery path, and the renderer's dev CSP
 * (`require-trusted-types-for 'script'`, stamped on every dev HTML entry) refuses
 * the blob URL. The throw aborts the module graph and `#root` stays empty.
 *
 * `updateStyle` is the one export that must NOT be a no-op: in dev every `.css`
 * import arrives as a JS module that calls it to append a `<style>` tag, so a
 * stub that drops it photographs raw, unstyled HTML that passes every "is it
 * mounted" check.
 */
export async function stubViteHmrClient(page: Page): Promise<void> {
  await page.route("**/@vite/client", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/javascript",
      body: [
        "const noop = () => {};",
        "export const createHotContext = () => ({ accept: noop, acceptExports: noop, dispose: noop, prune: noop, decline: noop, invalidate: noop, on: noop, off: noop, send: noop, data: {} });",
        "export const injectQuery = (u) => u;",
        "const sheets = new Map();",
        "export function updateStyle(id, content) {",
        "  let style = sheets.get(id);",
        "  if (!style) {",
        "    style = document.createElement('style');",
        "    style.setAttribute('type', 'text/css');",
        "    style.setAttribute('data-vite-dev-id', id);",
        "    style.textContent = content;",
        "    document.head.appendChild(style);",
        "    sheets.set(id, style);",
        "  } else {",
        "    style.textContent = content;",
        "  }",
        "}",
        "export function removeStyle(id) {",
        "  const style = sheets.get(id);",
        "  if (style) { document.head.removeChild(style); sheets.delete(id); }",
        "}",
      ].join("\n"),
    })
  );
}

/**
 * Build a `snap(target, file)` bound to one output directory. It asserts the
 * target is attached with a real box before writing and throws otherwise, so a
 * green run can never leave behind a blank picture.
 */
export function makeSnap(outDir: string) {
  return async function snap(target: Locator, file: string): Promise<string> {
    await expect(target).toBeAttached();
    const box = await target.boundingBox();
    if (!box || box.width < 8 || box.height < 8) {
      throw new Error(
        `${file}: target has no real box (${JSON.stringify(box)}) — refusing to write`
      );
    }
    const out = path.join(outDir, file);
    await target.screenshot({ path: out });
    return out;
  };
}
