import { describe, expect, it, vi } from "vitest";
import {
  DAINTREE_RUNBOOKS_MCP_URL,
  RUNBOOKS_MCP_URL_ENV_VAR,
  buildRunbooksAddendum,
  resolveRunbooksMcpUrl,
} from "../helpSessionRunbooks.js";

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
});
