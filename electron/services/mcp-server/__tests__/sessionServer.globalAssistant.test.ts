import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getVersion: () => "0.0.0-test" },
  webContents: { fromId: () => null },
}));
vi.mock("../../../store.js", () => ({ store: { get: vi.fn() } }));

import {
  GLOBAL_ASSISTANT_ID,
  GLOBAL_ASSISTANT_TOOL_IDS,
} from "../../../../shared/config/globalAssistant.js";
import { HOST_CONTROL_TOOL_IDS } from "../../../../shared/types/hostControl.js";
import { createSessionServer } from "../sessionServer.js";
import {
  createSessionServerDeps,
  type SessionServerDepsHost,
  type SessionServerDepsSource,
} from "../sessionServerDeps.js";
import { setHostControlRuntime, type HostControlRuntimeHandle } from "../hostControlTools.js";
import { getViewlessHelpBaseManifest } from "../baseManifest.js";
import { buildToolInputSchema, buildToolOutputSchema } from "../tierAuth.js";
import type { AssistantControlBinding } from "../shared.js";
import {
  callTool,
  fakeDeps,
  fakeSessionStore,
  listBaseTools,
  makeManifestEntry,
  makeMockTransport,
} from "./helpers/sessionServerFixture.js";

/**
 * The global assistant's discovery through the production composition
 * (#14453): the real session dependencies over the real generated manifests,
 * with nothing about which tools to expect handed in. A synthetic manifest
 * listing the roots is what let the empty global surface ship.
 */

const SESSION = "sess";
const HELP = "help-1";

let removeRuntime: (() => void) | null = null;
afterEach(() => {
  removeRuntime?.();
  removeRuntime = null;
});

function installHostRuntime(reachable: boolean): void {
  removeRuntime = setHostControlRuntime({
    isCallReachable: () => reachable,
  } as unknown as HostControlRuntimeHandle);
}

async function serverFor(
  viewlessProjectId: string,
  tier: "core" | "full",
  control: AssistantControlBinding["control"] | null = null,
  bound = control !== null
) {
  const sessionStore = fakeSessionStore(tier);
  const mutable = sessionStore as unknown as { sessionHelpIdMap: Map<string, string> };
  mutable.sessionHelpIdMap = new Map([[SESSION, HELP]]);
  sessionStore.sessionOriginMap.set(SESSION, "help");
  sessionStore.sessionViewlessHelpMap.set(SESSION, viewlessProjectId);
  const source = {
    sessionStore,
    turnOutcomeService: { getCurrentTurnIdForSession: vi.fn(() => null) },
    isAgentPaneInWorkspace: vi.fn(async () => false),
    // Nothing a view could describe: a viewless session must never ask.
    requestManifest: vi.fn(async () => {
      throw new Error("a viewless session asked a view for its manifest");
    }),
    getCachedManifest: vi.fn(() => null),
    dispatchAction: vi.fn(),
    dispatchActionWithoutView: vi.fn(),
  } as unknown as SessionServerDepsSource;
  const host: SessionServerDepsHost = {
    registry: () => null,
    // A live binding makes this session an assistant caller in its own lane's project.
    assistantControlBinding: () =>
      control === null || !bound ? null : { control, sessionProject: () => viewlessProjectId },
    helpSessionTerminalResolver: () => null,
    getBearerInfoForSession: () => null,
    assistantControl: control ?? ({} as AssistantControlBinding["control"]),
  };
  const role = viewlessProjectId === GLOBAL_ASSISTANT_ID ? "global-assistant" : "project-assistant";
  const deps = createSessionServerDeps(source, host, { sessionId: SESSION, role });
  const server = createSessionServer(SESSION, deps);
  await server.connect(makeMockTransport());
  return { server, source };
}

async function listFor(
  viewlessProjectId: string,
  tier: "core" | "full",
  control: AssistantControlBinding["control"] | null = null
) {
  const { server, source } = await serverFor(viewlessProjectId, tier, control);
  const tools = await listBaseTools(server);
  expect(source.requestManifest).not.toHaveBeenCalled();
  return tools;
}

/** An assistant control whose only target is the other global session (#18280). */
function peerControl() {
  const submit = vi.fn(async () => ({
    sent: true,
    terminalId: "t-peer",
    command: "x",
    submissionToken: "tok",
  }));
  const control = {
    isAssistantTerminal: (id: string) => id === "t-peer",
    resolve: (_caller: unknown, id: string) =>
      id === "t-peer"
        ? {
            scope: "global-peer",
            projectId: GLOBAL_ASSISTANT_ID,
            slot: 1,
            sessionId: "help-2",
            terminalId: "t-peer",
            attached: false,
          }
        : null,
    submit,
    list: vi.fn(),
  } as unknown as AssistantControlBinding["control"];
  return { control, submit };
}

describe("the global assistant's tool discovery (#14453)", () => {
  it.each(["core", "full"] as const)(
    "lists exactly its root tools at %s, with their real schemas",
    async (tier) => {
      installHostRuntime(true);
      const tools = await listFor(GLOBAL_ASSISTANT_ID, tier, peerControl().control);

      expect(tools.map((tool) => tool.name).sort()).toEqual([...GLOBAL_ASSISTANT_TOOL_IDS].sort());
      for (const tool of tools) {
        expect((tool.inputSchema as { type?: string } | undefined)?.type).toBe("object");
        // Every host tool takes arguments; `mcp.surface` takes none.
        if (HOST_CONTROL_TOOL_IDS.has(tool.name)) {
          expect(tool.inputSchema?.properties).toBeDefined();
        }
        expect(tool.outputSchema).toBeDefined();
        expect(tool.description).toBeTruthy();
      }
    }
  );

  it("serves the generated entries' own argument and result schemas", async () => {
    installHostRuntime(true);
    const tools = await listFor(GLOBAL_ASSISTANT_ID, "full", peerControl().control);
    const { MCP_GLOBAL_ASSISTANT_BASE_MANIFEST } =
      await import("../generated/mcpGlobalAssistantBaseManifest.js");

    for (const entry of MCP_GLOBAL_ASSISTANT_BASE_MANIFEST) {
      const tool = tools.find((candidate) => candidate.name === entry.id);
      expect(tool?.inputSchema).toEqual(buildToolInputSchema(entry));
      expect(tool?.outputSchema).toEqual(buildToolOutputSchema(entry));
    }
  });

  it("lists neither the peer listing nor its send with no assistant control (#18280)", async () => {
    installHostRuntime(true);
    const names = (await listFor(GLOBAL_ASSISTANT_ID, "full")).map((tool) => tool.name);
    expect(names).not.toContain("assistant.list");
    expect(names).not.toContain("terminal.sendCommand");
    expect(names).toContain("host.call");
  });

  it("lists only mcp.surface when the session isn't offered its hosts", async () => {
    installHostRuntime(false);
    expect((await listFor(GLOBAL_ASSISTANT_ID, "full")).map((tool) => tool.name)).toEqual([
      "mcp.surface",
    ]);
  });

  // #16765 — the healthy side of the comparison: a session that reached
  // another server under the same name would read another role here.
  it.each([true, false])(
    "answers mcp.surface as the global assistant, listing what tools/list does (hosts reachable: %s)",
    async (reachable) => {
      installHostRuntime(reachable);
      const { server, source } = await serverFor(GLOBAL_ASSISTANT_ID, "core");

      const result = await callTool(server, { name: "mcp.surface" });
      const listed = (await listBaseTools(server)).map((tool) => tool.name).sort();

      expect(result.isError).not.toBe(true);
      const report = result.structuredContent as { role: string; tools: Array<{ id: string }> };
      expect(report.role).toBe("global-assistant");
      expect(report.tools.map((tool) => tool.id)).toEqual(listed);
      expect(listed).toContain("mcp.surface");
      expect(source.requestManifest).not.toHaveBeenCalled();
      expect(source.dispatchAction).not.toHaveBeenCalled();
    }
  );

  // #16765 — whichever manifest answers, its report keeps to its own set as
  // its listing does.
  it("keeps a project's tools out of both its listing and its report", async () => {
    installHostRuntime(true);
    const sessionStore = fakeSessionStore("core");
    sessionStore.sessionOriginMap.set(SESSION, "help");
    sessionStore.sessionViewlessHelpMap.set(SESSION, GLOBAL_ASSISTANT_ID);
    const server = createSessionServer(
      SESSION,
      fakeDeps({
        sessionStore,
        sessionRole: "global-assistant",
        requestManifest: vi
          .fn()
          .mockResolvedValue(
            ["mcp.surface", "terminal.list", "actions.list"].map(makeManifestEntry)
          ),
      })
    );
    await server.connect(makeMockTransport());

    const listed = (await listBaseTools(server)).map((tool) => tool.name);
    const result = await callTool(server, { name: "mcp.surface" });
    const reported = (result.structuredContent as { tools: Array<{ id: string }> }).tools;

    expect(listed).toEqual(["mcp.surface"]);
    expect(reported.map((tool) => tool.id)).toEqual(["mcp.surface"]);
  });

  it("leaves a viewless project assistant's surface as it was", async () => {
    installHostRuntime(true);
    const names = (await listFor("proj-1", "full")).map((tool) => tool.name);

    expect(names.length).toBeGreaterThan(0);
    expect(names.filter((name) => HOST_CONTROL_TOOL_IDS.has(name))).toEqual([]);
    const catalog = new Set(getViewlessHelpBaseManifest().map((entry) => entry.id));
    expect(names.every((name) => catalog.has(name))).toBe(true);
  });
});

describe("the global assistant's send to its other session (#18280)", () => {
  it("sends to the other global session through the control, with nothing else run", async () => {
    installHostRuntime(true);
    const { control, submit } = peerControl();
    const { server, source } = await serverFor(GLOBAL_ASSISTANT_ID, "core", control);

    const result = await callTool(server, {
      name: "terminal.sendCommand",
      arguments: { terminalId: "t-peer", generation: 4, command: "The person wants X." },
    });

    expect(result.isError).not.toBe(true);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "local", projectId: GLOBAL_ASSISTANT_ID }),
      expect.objectContaining({ scope: "global-peer", terminalId: "t-peer" }),
      { command: "The person wants X.", generation: 4, handback: false }
    );
    expect(source.dispatchAction).not.toHaveBeenCalled();
    expect(source.dispatchActionWithoutView).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a worker or shell",
      /sends only to the other global session/,
      { terminalId: "t-worker", generation: 1, command: "x" },
    ],
    [
      "a batch",
      /sends only to the other global session/,
      { terminalIds: ["t-peer"], terminalId: "t-peer", generation: 4, command: "x" },
    ],
    [
      "a notice",
      /takes no `notify`/,
      { terminalId: "t-peer", generation: 4, command: "x", notify: true },
    ],
    [
      "a reply wait",
      /takes no `notify`/,
      { terminalId: "t-peer", generation: 4, command: "x", waitForReply: true },
    ],
    [
      "a handback",
      /takes no `notify`/,
      { terminalId: "t-peer", generation: 4, command: "x", handback: true },
    ],
  ])("refuses %s, sending nothing anywhere", async (_name, refusal, args) => {
    installHostRuntime(true);
    const { control, submit } = peerControl();
    const { server, source } = await serverFor(GLOBAL_ASSISTANT_ID, "full", control);

    const result = await callTool(server, { name: "terminal.sendCommand", arguments: args });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(refusal);
    expect(submit).not.toHaveBeenCalled();
    expect(source.dispatchAction).not.toHaveBeenCalled();
    expect(source.dispatchActionWithoutView).not.toHaveBeenCalled();
  });

  it("refuses a send from a session with no assistant control binding, reaching no terminal", async () => {
    installHostRuntime(true);
    const { control, submit } = peerControl();
    const { server, source } = await serverFor(GLOBAL_ASSISTANT_ID, "full", control, false);

    const result = await callTool(server, {
      name: "terminal.sendCommand",
      arguments: { terminalId: "t-peer", generation: 4, command: "x" },
    });

    expect(result.isError).toBe(true);
    expect(submit).not.toHaveBeenCalled();
    expect(source.dispatchAction).not.toHaveBeenCalled();
    expect(source.dispatchActionWithoutView).not.toHaveBeenCalled();
  });
});
