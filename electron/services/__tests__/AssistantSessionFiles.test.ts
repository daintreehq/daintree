import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

vi.mock("electron", () => ({
  app: { getPath: () => os.tmpdir() },
}));

import { assistantLaneMcpConfigName } from "../../../shared/config/assistantSlots.js";
import { AssistantSessionFiles, type AssistantSessionOwners } from "../AssistantSessionFiles.js";

type Owner = { revoked: boolean; agentId: string; sessionPath: string };

function ownersFrom(byToken: Map<string, Owner>, byId: Map<string, Owner>): AssistantSessionOwners {
  return {
    byToken: (token) => byToken.get(token),
    bySessionId: (sessionId) => byId.get(sessionId),
    all: () => byToken.values(),
  };
}

async function writeMcpJson(sessionPath: string, authorization: string): Promise<void> {
  await fs.writeFile(
    path.join(sessionPath, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        "daintree-docs": { type: "http", url: "https://docs" },
        daintree: {
          type: "sse",
          url: "http://127.0.0.1:1/sse",
          headers: { Authorization: authorization },
        },
      },
    })
  );
}

async function readServers(sessionPath: string): Promise<Record<string, unknown>> {
  const raw = await fs.readFile(path.join(sessionPath, ".mcp.json"), "utf-8");
  return (JSON.parse(raw) as { mcpServers: Record<string, unknown> }).mcpServers;
}

describe("AssistantSessionFiles owners lookup", () => {
  let sessionPath: string;
  let otherPath: string;
  const byToken = new Map<string, Owner>();
  const byId = new Map<string, Owner>();

  beforeEach(async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "assistant-session-files-"));
    sessionPath = path.join(root, "abc");
    otherPath = path.join(root, "def");
    await fs.mkdir(sessionPath, { recursive: true });
    await fs.mkdir(otherPath, { recursive: true });
    byToken.clear();
    byId.clear();
  });

  afterEach(async () => {
    await fs.rm(path.dirname(sessionPath), { recursive: true, force: true });
  });

  it("keeps a bearer whose live session owns this directory", async () => {
    byToken.set("tok", { revoked: false, agentId: "claude", sessionPath });
    await writeMcpJson(sessionPath, "Bearer tok");
    await new AssistantSessionFiles(ownersFrom(byToken, byId)).stripStaleDaintreeMcpEntry(
      sessionPath
    );
    expect(Object.keys(await readServers(sessionPath))).toContain("daintree");
  });

  it("judges a literal bearer by its token's presence, not its revoked flag", async () => {
    const files = new AssistantSessionFiles(ownersFrom(byToken, byId));
    byToken.set("tok", { revoked: true, agentId: "claude", sessionPath });
    await writeMcpJson(sessionPath, "Bearer tok");
    await files.stripStaleDaintreeMcpEntry(sessionPath);
    expect(Object.keys(await readServers(sessionPath))).toContain("daintree");

    byToken.delete("tok");
    await files.stripStaleDaintreeMcpEntry(sessionPath);
    expect(Object.keys(await readServers(sessionPath))).toEqual(["daintree-docs"]);
  });

  it("strips a bearer no session owns, or one owned by another directory", async () => {
    const files = new AssistantSessionFiles(ownersFrom(byToken, byId));
    await writeMcpJson(sessionPath, "Bearer gone");
    await files.stripStaleDaintreeMcpEntry(sessionPath);
    expect(Object.keys(await readServers(sessionPath))).toEqual(["daintree-docs"]);

    byToken.set("elsewhere", { revoked: false, agentId: "claude", sessionPath: otherPath });
    await writeMcpJson(sessionPath, "Bearer elsewhere");
    await files.stripStaleDaintreeMcpEntry(sessionPath);
    expect(Object.keys(await readServers(sessionPath))).toEqual(["daintree-docs"]);
  });

  it("keeps the Copilot placeholder only while a live Copilot session owns the directory", async () => {
    const files = new AssistantSessionFiles(ownersFrom(byToken, byId));
    byToken.set("cp", { revoked: false, agentId: "copilot", sessionPath });
    await writeMcpJson(sessionPath, "Bearer $DAINTREE_MCP_TOKEN");
    await files.stripStaleDaintreeMcpEntry(sessionPath);
    expect(Object.keys(await readServers(sessionPath))).toContain("daintree");

    byToken.get("cp")!.revoked = true;
    await files.stripStaleDaintreeMcpEntry(sessionPath);
    expect(Object.keys(await readServers(sessionPath))).toEqual(["daintree-docs"]);
  });

  it.each([
    {
      name: "an unknown literal bearer beside a live Copilot owner",
      auth: "Bearer unknown",
      owner: { agentId: "copilot", own: true },
    },
    {
      name: "the placeholder when only a live Claude owns the directory",
      auth: "Bearer $DAINTREE_MCP_TOKEN",
      owner: { agentId: "claude", own: true },
    },
    {
      name: "the placeholder when the live Copilot owns another directory",
      auth: "Bearer $DAINTREE_MCP_TOKEN",
      owner: { agentId: "copilot", own: false },
    },
  ])("strips $name", async ({ auth, owner }) => {
    byToken.set("live", {
      revoked: false,
      agentId: owner.agentId,
      sessionPath: owner.own ? sessionPath : otherPath,
    });
    await writeMcpJson(sessionPath, auth);
    await new AssistantSessionFiles(ownersFrom(byToken, byId)).stripStaleDaintreeMcpEntry(
      sessionPath
    );
    expect(Object.keys(await readServers(sessionPath))).toEqual(["daintree-docs"]);
  });

  it("sweeps lane configs whose session is gone or revoked, keeping live ones", async () => {
    const laneDir = path.join(sessionPath, ".lanes");
    await fs.mkdir(laneDir, { recursive: true });
    const files = new AssistantSessionFiles(ownersFrom(byToken, byId));
    const live = "11111111-1111-4111-8111-111111111111";
    const revoked = "22222222-2222-4222-8222-222222222222";
    const gone = "33333333-3333-4333-8333-333333333333";
    byId.set(live, { revoked: false, agentId: "claude", sessionPath });
    byId.set(revoked, { revoked: true, agentId: "claude", sessionPath });
    const names = [live, revoked, gone].map((id, slot) => assistantLaneMcpConfigName(slot, id));
    await Promise.all(names.map((name) => fs.writeFile(path.join(laneDir, name), "{}")));
    await fs.writeFile(path.join(laneDir, "stray.txt"), "");

    await files.sweepStaleLaneConfigs(sessionPath);

    expect(await fs.readdir(laneDir)).toEqual([names[0]]);
  });
});
