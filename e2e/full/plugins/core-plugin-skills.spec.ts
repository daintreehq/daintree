import { test, expect } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { closeApp, type AppContext } from "../../helpers/launch";
import { launchWithSamplePlugin } from "../../helpers/plugins";
import { T_LONG } from "../../helpers/timeouts";

/**
 * Skills contribution point (#10892) — the full contract, end to end. The
 * sample `hello-daintree` plugin contributes a `tdd-workflow` skill (a markdown
 * file). This spec enables the built-in MCP server, connects a real MCP client
 * over HTTP, and asserts the skill is discoverable via `skills.search` and its
 * body is retrievable via `skills.load` — proving the manifest → registry →
 * MCP-tool path works in a live app, not just in unit tests.
 */
test.describe.serial("Core: Plugin skills (#10892)", () => {
  let ctx: AppContext;
  let fixtureCleanup: (() => void) | undefined;
  let client: Client | undefined;
  let transport: StreamableHTTPClientTransport | undefined;

  test.beforeAll(async () => {
    const { ctx: launched, cleanup } = await launchWithSamplePlugin("plugin-skills");
    ctx = launched;
    fixtureCleanup = cleanup;
  });

  test.afterAll(async () => {
    if (client) await client.close().catch(() => {});
    if (transport) await transport.close().catch(() => {});
    if (ctx?.window) {
      await ctx.window
        .evaluate(async () => {
          await window.electron.mcpServer.setEnabled(false);
        })
        .catch(() => {});
    }
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("exposes the sample plugin's skill via skills.search / skills.load", async () => {
    await ctx.window.evaluate(async () => {
      await window.electron.mcpServer.setEnabled(true);
    });

    await expect
      .poll(
        async () => {
          const status = await ctx.window.evaluate(async () =>
            window.electron.mcpServer.getStatus()
          );
          return status.port ?? 0;
        },
        { timeout: T_LONG }
      )
      .toBeGreaterThan(0);

    const status = await ctx.window.evaluate(async () => window.electron.mcpServer.getStatus());
    expect(status.port ?? 0).toBeGreaterThan(0);
    expect(status.apiKey.length).toBeGreaterThan(0);

    client = new Client({ name: "e2e-skills-client", version: "1.0.0" });
    transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${status.port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${status.apiKey}` } },
    });
    await client.connect(transport);

    const toolNames = (await client.listTools()).tools.map((tool) => tool.name);
    expect(toolNames).toContain("skills.search");
    expect(toolNames).toContain("skills.load");

    const search = await client.callTool({ name: "skills.search", arguments: { query: "tdd" } });
    const searchData = search.structuredContent as { skills: Array<{ id: string }> };
    expect(searchData.skills.map((s) => s.id)).toContain("daintree.hello.tdd-workflow");

    const loaded = await client.callTool({
      name: "skills.load",
      arguments: { id: "daintree.hello.tdd-workflow" },
    });
    const loadedData = loaded.structuredContent as { id: string; body: string };
    expect(loadedData.id).toBe("daintree.hello.tdd-workflow");
    // The body is returned verbatim; the frontmatter delimiter is stripped.
    expect(loadedData.body).toContain("Red-Green-Refactor");
    expect(loadedData.body).not.toContain("applies_to");
  });
});
