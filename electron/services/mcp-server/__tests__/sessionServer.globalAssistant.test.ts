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
  fakeSessionStore,
  listBaseTools,
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

async function listFor(viewlessProjectId: string, tier: "core" | "full") {
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
    assistantControlBinding: () => null,
    helpSessionTerminalResolver: () => null,
    getBearerInfoForSession: () => null,
    assistantControl: {} as AssistantControlBinding["control"],
  };
  const deps = createSessionServerDeps(source, host, { sessionId: SESSION });
  const server = createSessionServer(SESSION, deps);
  await server.connect(makeMockTransport());
  const tools = await listBaseTools(server);
  expect(source.requestManifest).not.toHaveBeenCalled();
  return tools;
}

describe("the global assistant's tool discovery (#14453)", () => {
  it.each(["core", "full"] as const)(
    "lists exactly its root tools at %s, with their real schemas",
    async (tier) => {
      installHostRuntime(true);
      const tools = await listFor(GLOBAL_ASSISTANT_ID, tier);

      expect(tools.map((tool) => tool.name).sort()).toEqual([...GLOBAL_ASSISTANT_TOOL_IDS].sort());
      for (const tool of tools) {
        expect((tool.inputSchema as { type?: string } | undefined)?.type).toBe("object");
        expect(tool.inputSchema?.properties).toBeDefined();
        expect(tool.outputSchema).toBeDefined();
        expect(tool.description).toBeTruthy();
      }
    }
  );

  it("serves the generated entries' own argument and result schemas", async () => {
    installHostRuntime(true);
    const tools = await listFor(GLOBAL_ASSISTANT_ID, "full");
    const { MCP_GLOBAL_ASSISTANT_BASE_MANIFEST } =
      await import("../generated/mcpGlobalAssistantBaseManifest.js");

    for (const entry of MCP_GLOBAL_ASSISTANT_BASE_MANIFEST) {
      const tool = tools.find((candidate) => candidate.name === entry.id);
      expect(tool?.inputSchema).toEqual(buildToolInputSchema(entry));
      expect(tool?.outputSchema).toEqual(buildToolOutputSchema(entry));
    }
  });

  it("lists nothing when the session isn't offered its hosts", async () => {
    installHostRuntime(false);
    expect(await listFor(GLOBAL_ASSISTANT_ID, "full")).toEqual([]);
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
