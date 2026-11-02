import { describe, expect, it, vi } from "vitest";
import {
  DAINTREE_RUNBOOKS_MCP_URL,
  RUNBOOKS_MCP_URL_ENV_VAR,
  buildConfirmationsAddendum,
  buildRunbooksAddendum,
  buildRunbooksHeaders,
  resolveRunbooksMcpUrl,
} from "../helpSessionRunbooks.js";
import { GLOBAL_ASSISTANT_TOOL_IDS } from "../../../shared/config/globalAssistant.js";
import { WORKER_STEER_SLASH_FORMS } from "../../../shared/config/workerSteerCommands.js";

describe("buildRunbooksHeaders (#13496, #14458)", () => {
  it("names the host-control model and never a host state or lane", () => {
    expect(buildRunbooksHeaders()).toEqual({ "Daintree-Host-Control": "1" });
  });
});

describe("resolveRunbooksMcpUrl", () => {
  it("uses the production endpoint when no override is set", () => {
    expect(resolveRunbooksMcpUrl({})).toBe(DAINTREE_RUNBOOKS_MCP_URL);
    expect(resolveRunbooksMcpUrl({ [RUNBOOKS_MCP_URL_ENV_VAR]: "  " })).toBe(
      DAINTREE_RUNBOOKS_MCP_URL
    );
  });

  it("honours a plain http(s) override", () => {
    const local = "http://127.0.0.1:8473/v1/daintree/mcp";
    expect(resolveRunbooksMcpUrl({ [RUNBOOKS_MCP_URL_ENV_VAR]: local })).toBe(local);
  });

  it.each([
    "not a url",
    "file:///etc/passwd",
    "http://user:pass@127.0.0.1:8473/mcp",
    'http://127.0.0.1:8473/mcp" --x="1',
    "http://127.0.0.1:8473/mcp\\",
  ])("falls back to production for an override it can't embed safely: %s", (raw) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveRunbooksMcpUrl({ [RUNBOOKS_MCP_URL_ENV_VAR]: raw })).toBe(
      DAINTREE_RUNBOOKS_MCP_URL
    );
    warn.mockRestore();
  });
});

describe("buildRunbooksAddendum", () => {
  const text = buildRunbooksAddendum();

  // A how-to exemption alone let "how much usage is left?" skip the search
  // and the runbook that reads it from the CLIs.
  it("makes the search a requirement before acting, and exempts only chat and how-to", () => {
    expect(text).toContain("**Before acting on any request to do something, call it**");
    expect(text).toContain("before your first `daintree` call");
    expect(text).toContain('**Never search for chat or a "how do I…" question:**');
    // The exemption leads, so it is read before the rule it narrows.
    expect(text.indexOf("Never search for chat")).toBeLessThan(
      text.indexOf("**Before acting on any request")
    );
    expect(text).toContain("A question about live state");
  });

  // A live Codex run searched again for a step of its task and for closing its
  // own agents afterwards, each a wasted round.
  it("allows one search per task", () => {
    expect(text).toContain("**One search per task:**");
    expect(text).toContain("closing its agents included");
  });

  // The query shape was measured against the selector: a one-sentence summary
  // in the user's voice routes as well as the raw message, while narrated or
  // "ask …" phrasings land on the agent-question runbooks.
  it("asks for a short, specific-free summary in the user's voice", () => {
    expect(text).toContain("one sentence, 8–15 words");
    expect(text).toContain("Leave out specifics");
    expect(text).toContain("Don't narrate");
    expect(text).toContain("`max_results: 3`");
  });

  it("follows only selected runbooks", () => {
    expect(text).toContain("`selected: true`");
    expect(text).toContain("None selected");
  });

  // #14161 — the swap to unscoped names held only in the caller's own project.
  describe("tool names, by the caller's real surface", () => {
    const toolNamesIn = (addendum: string) =>
      [...addendum.matchAll(/`([a-z]+\.[A-Za-z]+)`/g)].map((match) => match[1]!);

    it("tells the global assistant only of its root tools and the owned ones host.call admits", () => {
      const global = buildRunbooksAddendum({ global: true });
      const named = toolNamesIn(global);
      expect(named).toEqual(expect.arrayContaining([...GLOBAL_ASSISTANT_TOOL_IDS]));
      for (const name of named) {
        if (GLOBAL_ASSISTANT_TOOL_IDS.has(name)) continue;
        // Every other tool it is told of runs on a host: the owned ones, and the search for them.
        if (name === "actions.search") continue;
        expect(name).toMatch(/Owned$/);
      }
      expect(global).toContain("`actions.search` through `host.call`");
      expect(global).not.toContain("yours is");
      expect(buildRunbooksAddendum()).not.toContain("through `host.call`,");
    });

    // #16101 — a steered slash command is refused unless it is one of these.
    it("tells only the global assistant the slash forms a steer runs, as the steer enforces them", () => {
      const global = buildRunbooksAddendum({ global: true });
      for (const forms of Object.values(WORKER_STEER_SLASH_FORMS)) {
        for (const form of forms) expect(global).toContain(`\`${form}\``);
      }
      expect(global).toContain("sent alone without `handback`");
      expect(text).not.toContain("`/goal resume`");
    });

    it("keeps a project's assistant on the unscoped names in its own project alone", () => {
      const named = toolNamesIn(text);
      expect(named).toEqual(
        expect.arrayContaining(["terminal.sendCommand", "terminal.sendCommandOwned", "host.call"])
      );
      // The swap is scoped before it is given, never blanket.
      expect(text.indexOf("own project")).toBeLessThan(text.indexOf("yours is"));
    });
  });
});

describe("buildConfirmationsAddendum (#12874)", () => {
  it("overrides the shared prompt's promise that confirm-gated actions wait", () => {
    const note = buildConfirmationsAddendum();
    expect(note).toContain("## Daintree Confirmations");
    expect(note).toContain("no typed-name check");
    expect(note).toContain("Refusals still apply");
  });

  it("covers protected and bulk closes without dropping the close-only-what-was-asked guidance (#12989)", () => {
    const note = buildConfirmationsAddendum();
    expect(note).toContain("closing a panel you didn't open");
    expect(note).toContain("closing panels in bulk");
    expect(note).toContain("close and remove only what the user asked for");
    expect(note).toContain("a tool outside your tool set");
  });
});
