/**
 * Documentation screenshots — the MCP control surface.
 *
 * Both states need a real MCP client, so the spec is one: it enables the
 * server, speaks JSON-RPC to it over HTTP, and photographs what the app does
 * in response.
 *
 * Two constraints shape the confirm shot. `worktree.delete` is not on the
 * external surface at all — the external counterpart is `worktree.deleteOwned`,
 * which requires the calling session to have created the worktree, and which
 * delegates to `worktree.delete` so the dialog is the real one. And the session
 * must NOT be workspace-bound: a bound session is refused every
 * `danger:"confirm"` tool at both discovery and dispatch.
 */

import { test, expect, type Page } from "@playwright/test";
import { rmSync } from "fs";
import { closeApp, type AppContext } from "../helpers/launch";
import { SEL } from "../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG } from "../helpers/timeouts";
import { createAtlasLedgerRepo, attachLocalOrigin, DOCS_DEMO_ROOT } from "../helpers/docsFixtures";
import { createCapture, resetOverlays, settleScroll } from "../helpers/docsCapture";
import { bootDocsApp, DIALOG_PAD } from "../helpers/docsBoot";
import type { DemoRepo } from "../helpers/screenshotFixtures";

process.env.DAINTREE_DEMO_ROOT = DOCS_DEMO_ROOT;

const cap = createCapture("mcp");

interface Endpoint {
  port: number;
  apiKey: string;
}

/** One JSON-RPC POST. `token` overrides the api key for help-session calls. */
async function rpc(
  endpoint: Endpoint,
  body: unknown,
  opts: { sessionId?: string; token?: string; clientName?: string } = {}
): Promise<{ status: number; sessionId?: string; json?: unknown }> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${opts.token ?? endpoint.apiKey}`,
    "user-agent": opts.clientName ?? "Claude Code/2.1.0",
  };
  if (opts.sessionId) headers["mcp-session-id"] = opts.sessionId;
  const res = await fetch(`http://127.0.0.1:${endpoint.port}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown;
  try {
    // An SSE response wraps the payload in `data:` lines.
    const line = text.split("\n").find((l) => l.startsWith("data:")) ?? text;
    json = JSON.parse(line.replace(/^data:\s*/, ""));
  } catch {
    json = undefined;
  }
  return { status: res.status, sessionId: res.headers.get("mcp-session-id") ?? undefined, json };
}

async function initialize(endpoint: Endpoint, token?: string): Promise<string> {
  const init = await rpc(
    endpoint,
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "Claude Code", version: "2.1.0" },
      },
    },
    { token }
  );
  if (!init.sessionId) throw new Error(`initialize returned no session (${init.status})`);
  await rpc(
    endpoint,
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { sessionId: init.sessionId, token }
  );
  return init.sessionId;
}

async function callTool(
  endpoint: Endpoint,
  sessionId: string,
  name: string,
  args: unknown,
  token?: string
): Promise<unknown> {
  const out = await rpc(
    endpoint,
    { jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name, arguments: args } },
    { sessionId, token }
  );
  return out.json;
}

/** Turn the server on and read back the port and key. */
async function mcpEndpoint(page: Page): Promise<Endpoint> {
  const info = await page.evaluate(async () => {
    const enabled = await window.electron.mcpServer.setEnabled(true);
    const status = await window.electron.mcpServer.getStatus();
    return {
      port: (status as { port?: number })?.port ?? 0,
      apiKey:
        (status as { apiKey?: string })?.apiKey ?? (enabled as { apiKey?: string })?.apiKey ?? "",
    };
  });
  if (!info.port || !info.apiKey) throw new Error("MCP server did not report a port and key");
  return info;
}

test.describe.serial("Documentation Screenshots — MCP", () => {
  test.afterAll(() => {
    cap.writeReport();
  });

  test("scene-m1-mcp", async () => {
    const repo: DemoRepo = createAtlasLedgerRepo();
    attachLocalOrigin(repo);
    let ctx: AppContext | undefined;
    let profile = "";
    try {
      const booted = await bootDocsApp({
        repoDir: repo.dir,
        displayName: "Atlas Ledger",
        emoji: "📒",
        windowSize: { width: 1280, height: 1560 },
      });
      ctx = booted.ctx;
      profile = booted.userDataDir;
      const { page } = booted;

      const endpoint = await mcpEndpoint(page);

      await cap.shot("mcp-server/mcp-server-confirm-dialog", async () => {
        await resetOverlays(page);
        // No Daintree-Workspace-Id header: a workspace-bound session is
        // refused every confirm-gated tool, so it could never raise this
        // dialog at all.
        const session = await initialize(endpoint);
        const created = (await callTool(endpoint, session, "worktree.createWithRecipe", {
          branchName: "docs/mcp-demo",
        })) as { result?: { content?: Array<{ text?: string }> } };
        const text = created?.result?.content?.[0]?.text ?? "{}";
        const worktreeId = (JSON.parse(text) as { worktreeId?: string }).worktreeId;
        if (!worktreeId) throw new Error(`no worktreeId from createWithRecipe: ${text}`);

        // Fire and forget: the HTTP call blocks on the human decision, so
        // awaiting it here would deadlock against the screenshot.
        const pending = callTool(endpoint, session, "worktree.deleteOwned", { worktreeId });

        const dialog = page
          .locator('[role="alertdialog"]')
          .filter({ hasText: /Delete Worktree|worktree/i })
          .first();
        await expect(dialog).toBeVisible({ timeout: T_LONG * 2 });
        // The confirm button holds a short cooldown and the preview is
        // fetched asynchronously; both settle well inside this.
        await page.waitForTimeout(T_MEDIUM);
        await cap.snapElement(
          page,
          dialog.locator("> div").first(),
          "mcp-server/mcp-server-confirm-dialog",
          DIALOG_PAD
        );
        await page.locator('[data-confirm-role="cancel"]').first().click().catch(async () => {
          await page.keyboard.press("Escape");
        });
        await pending.catch(() => {});
      });

      await cap.shot("mcp-server/mcp-server-audit-log", async () => {
        await resetOverlays(page);
        // The audit viewer that also carries the latency table lives on the
        // Assistant tab, and it filters out `external`-tier records — so
        // api-key traffic never appears there however much of it there is.
        // A help session mints a workbench-tier bearer without spawning
        // anything, and its dispatches do land.
        await page.evaluate(async () => {
          await window.electron.helpAssistant.setSettings({ tier: "system" } as never);
        });
        const help = await page.evaluate(async () => {
          const p = await window.electron.project.getCurrent();
          if (!p?.id) return null;
          return window.electron.help.provisionSession({
            projectId: p.id,
            projectPath: p.path,
            agentId: "daintree-assistant",
          } as never);
        });
        const token = (help as { token?: string } | null)?.token;
        if (!token) throw new Error("help.provisionSession returned no token");

        const session = await initialize(endpoint, token);
        // Enough dispatches that the per-tool table has rows to aggregate,
        // with a couple of deliberate failures so the result filter and the
        // failed sub-rows have something in them.
        for (let i = 0; i < 8; i++) {
          await callTool(endpoint, session, "worktree.list", {}, token);
          await callTool(endpoint, session, "terminal.list", {}, token);
        }
        for (const name of ["actions.getContext", "recipe.list", "worktree.getCurrent"]) {
          await callTool(endpoint, session, name, {}, token);
        }
        // A schema rejection and an out-of-tier call, for the failure rows.
        await callTool(endpoint, session, "worktree.list", { limit: "not-a-number" }, token);
        await callTool(endpoint, session, "definitely.not.a.tool", {}, token);

        await page.evaluate(() => {
          window.__daintreeDispatchAction?.(
            "app.settings.openTab",
            { tab: "assistant" },
            { source: "user" }
          );
        });
        await expect(page.locator(SEL.settings.heading)).toBeVisible({ timeout: T_LONG });
        const advanced = page
          .locator("button[aria-expanded]")
          .filter({ hasText: /Advanced diagnostics/i })
          .first();
        await expect(advanced).toBeVisible({ timeout: T_LONG });
        if ((await advanced.getAttribute("aria-expanded")) !== "true") await advanced.click();
        // Gate on the latency table, which is the half of this shot that the
        // MCP tab's own viewer does not have.
        const latency = page
          .locator("button[aria-expanded]")
          .filter({ hasText: /Latency by tool/i })
          .first();
        await expect(latency).toBeVisible({ timeout: T_LONG });

        // `.settings-section-header` is a sticky bar tinted to 80% and relying
        // on `backdrop-filter: blur(8px)` to hide what scrolls beneath it. The
        // capture harness launches with `--disable-gpu`, under which the blur
        // is a no-op — so the first attempt at this shot had the Privacy
        // heading painted straight through the top audit record. Force the
        // opaque variant the app itself ships for
        // `prefers-reduced-transparency: reduce`, which is what a GPU build
        // renders anyway.
        await page.addStyleTag({
          content: `.settings-section-header {
            background: var(--settings-section-header-bg-solid, var(--theme-surface-panel)) !important;
            backdrop-filter: none !important;
            -webkit-backdrop-filter: none !important;
          }`,
        });
        // Put the Advanced diagnostics block at the top of the scrollport so
        // the record list and the latency table are in frame together — they
        // are the two halves the page describes. `scroll-margin-top` keeps it
        // clear of the pinned Privacy header rather than under it.
        await advanced.evaluate((el) => {
          const header = document.querySelector(".settings-section-header");
          const offset = header ? header.getBoundingClientRect().height + 8 : 56;
          const box = el.closest("div") ?? el;
          (box as HTMLElement).style.scrollMarginTop = `${offset}px`;
          box.scrollIntoView({ block: "start", behavior: "auto" });
        });
        await settleScroll(page);
        await expect(latency).toBeVisible();
        await page.waitForTimeout(T_MEDIUM);
        // Crop to the dialog card. The dialog *root* is `fixed inset-0`, so
        // targeting it captures the whole window and its blurred backdrop.
        const card = page
          .locator('[role="dialog"]')
          .filter({ has: page.locator(SEL.settings.heading) })
          .first()
          .locator("> div")
          .first();
        await cap.snapElement(page, card, "mcp-server/mcp-server-audit-log", DIALOG_PAD);
        await resetOverlays(page);
      });
    } finally {
      if (ctx) await closeApp(ctx.app).catch(() => {});
      repo.cleanup();
      if (profile) rmSync(profile, { recursive: true, force: true });
    }
  });
});
