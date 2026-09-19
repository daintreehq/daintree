import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hand-over decisions (#12490) are made in the service from main-side facts
// alone — the pane's bearer, the pty-host's spawn tracking and the ownership
// ledger — so this suite drives the service with those facts and nothing the
// renderer could forge.

const testHomeDir = vi.hoisted(
  () => `${process.cwd()}/.vitest-mcp-adoption-${Math.random().toString(36).slice(2)}`
);

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getPath: vi.fn(() => testHomeDir),
    setPath: vi.fn(),
    getVersion: vi.fn(() => "0.0.0-test"),
    commandLine: { appendSwitch: vi.fn() },
    on: vi.fn(),
    once: vi.fn(),
    whenReady: vi.fn(() => Promise.resolve()),
  },
  ipcMain: { on: vi.fn(), off: vi.fn(), removeListener: vi.fn(), handle: vi.fn() },
  webContents: { fromId: vi.fn(() => null), getAllWebContents: vi.fn(() => []) },
  safeStorage: { isEncryptionAvailable: vi.fn(() => false) },
}));

vi.mock("../../window/windowRef.js", () => ({
  getProjectViewManager: () => null,
  getWindowRegistry: () => null,
  setWindowRegistry: vi.fn(),
}));

vi.mock("../../window/webContentsRegistry.js", () => ({
  getWebContentsForProject: () => [],
  getProjectForWebContents: () => null,
}));

import { McpServerService } from "../McpServerService.js";
import { setPtyClientRef } from "../../window/serviceRefs.js";
import { events } from "../events.js";
import type { PtyClient } from "../PtyClient.js";
import type { OrchestratorPaneIdentity } from "../McpPaneConfigService.js";

const ORCHESTRATOR: OrchestratorPaneIdentity = {
  principalId: "principal-orch",
  tier: "action",
  workspaceId: "project-a",
};

describe("McpServerService terminal hand-over (#12490)", () => {
  const service = new McpServerService();
  const terminals = new Map<string, string | null>();
  const generations = new Map<string, number>();

  beforeEach(() => {
    terminals.clear();
    generations.clear();
    terminals.set("terminal-1", "project-a");
    terminals.set("pane-orch", "project-a");
    generations.set("terminal-1", 3);
    setPtyClientRef({
      hasTerminal: (id: string) => terminals.has(id),
      getTerminalProjectId: (id: string) => terminals.get(id) ?? null,
      getLaunchGeneration: (id: string) => generations.get(id) ?? null,
    } as unknown as PtyClient);
  });

  afterEach(() => {
    for (const adoption of service.listTerminalAdoptions()) {
      service.releaseTerminalAdoption(adoption.terminalId);
    }
    service._sessionStore.resourceOwnership.revokePrincipal(ORCHESTRATOR.principalId);
    setPtyClientRef(null);
  });

  afterAll(() => {
    service._sessionStore.drain();
    service._sessionStore.grantCache.dispose();
  });

  function adopt(overrides: Partial<Parameters<McpServerService["adoptTerminal"]>[0]> = {}) {
    return service.adoptTerminal({
      terminalId: "terminal-1",
      orchestratorPaneId: "pane-orch",
      orchestrator: ORCHESTRATOR,
      callerWorkspaceId: "project-a",
      ...overrides,
    });
  }

  it("hands a running terminal to a pane that can submit input", () => {
    const result = adopt();

    expect(result).toEqual({
      status: "handed-over",
      adoption: {
        terminalId: "terminal-1",
        orchestratorPaneId: "pane-orch",
        adoptedAt: expect.any(Number),
      },
    });
    expect(service.listTerminalAdoptions().map((a) => a.terminalId)).toEqual(["terminal-1"]);
  });

  it("refuses a pane with no bearer, and one whose tier cannot submit input", () => {
    expect(adopt({ orchestrator: null })).toEqual({
      status: "refused",
      reason: "not-orchestrator",
    });
    expect(adopt({ orchestrator: { ...ORCHESTRATOR, tier: "workbench" } })).toEqual({
      status: "refused",
      reason: "not-orchestrator",
    });
    expect(service.listTerminalAdoptions()).toEqual([]);
  });

  it("refuses the pane itself, a terminal that is gone, and a terminal in another project", () => {
    expect(adopt({ terminalId: "pane-orch" })).toMatchObject({ reason: "self" });
    expect(adopt({ terminalId: "terminal-gone" })).toMatchObject({ reason: "terminal-gone" });

    terminals.set("terminal-elsewhere", "project-b");
    expect(adopt({ terminalId: "terminal-elsewhere" })).toMatchObject({ reason: "other-project" });
    // The view the user acted in counts too: one project's view cannot hand
    // over a terminal that belongs to another.
    expect(adopt({ callerWorkspaceId: "project-b" })).toMatchObject({ reason: "other-project" });
    expect(service.listTerminalAdoptions()).toEqual([]);
  });

  it("refuses a terminal another client launched, and says so when the pane launched it itself", () => {
    const ownership = service._sessionStore.resourceOwnership;
    ownership.record("s-api", [{ kind: "terminal", id: "terminal-1" }]);
    expect(adopt()).toMatchObject({ reason: "launched-by-another" });
    ownership.clearSession("s-api");

    ownership.bindPrincipal("s-orch", ORCHESTRATOR.principalId);
    ownership.record(ownership.ownerOf("s-orch"), [{ kind: "terminal", id: "terminal-1" }]);
    expect(adopt()).toMatchObject({ reason: "launched-by-orchestrator" });
    expect(service.listTerminalAdoptions()).toEqual([]);
  });

  it("refuses a second pane and names the one already driving the terminal", () => {
    adopt();

    const second = adopt({
      orchestratorPaneId: "pane-other",
      orchestrator: { ...ORCHESTRATOR, principalId: "principal-other" },
    });

    expect(second).toEqual({
      status: "refused",
      reason: "already-handed",
      heldByPaneId: "pane-orch",
    });
  });

  it("ends when the orchestrator's bearer is revoked, as a relaunch does", () => {
    adopt();

    service.revokeOwnershipPrincipal(ORCHESTRATOR.principalId);

    expect(service.listTerminalAdoptions()).toEqual([]);
  });

  it("ends when the handed-over terminal is trashed", () => {
    adopt();

    events.emit("terminal:trashed", { id: "terminal-1", expiresAt: Date.now() + 60_000 });

    expect(service.listTerminalAdoptions()).toEqual([]);
  });

  it("survives the spawn result of the launch it was made against, and earlier ones", () => {
    // A terminal can be handed over while its own spawn is still pending; the
    // confirmation of that very launch is not a new process.
    adopt();

    service.handleTerminalSpawnResult("terminal-1", true, 3);
    service.handleTerminalSpawnResult("terminal-1", true, 2);
    service.handleTerminalSpawnResult("terminal-1", false, 4);

    expect(service.listTerminalAdoptions().map((a) => a.terminalId)).toEqual(["terminal-1"]);
  });

  it("ends when a later launch takes the id, or the handed-over launch never starts", () => {
    adopt();
    service.handleTerminalSpawnResult("terminal-1", true, 4);
    expect(service.listTerminalAdoptions()).toEqual([]);

    adopt();
    service.handleTerminalSpawnResult("terminal-1", false, 3);
    expect(service.listTerminalAdoptions()).toEqual([]);
  });

  it("ends on a spawn result it cannot place", () => {
    generations.delete("terminal-1");
    adopt();

    service.handleTerminalSpawnResult("terminal-1", true, 3);

    expect(service.listTerminalAdoptions()).toEqual([]);
  });

  it("tells subscribers the whole list on every change", () => {
    const listener = vi.fn();
    const off = service.onTerminalAdoptionsChange(listener);

    adopt();
    service.releaseTerminalAdoption("terminal-1");
    off();
    adopt();

    expect(listener.mock.calls.map(([adoptions]) => adoptions.length)).toEqual([1, 0]);
  });

  it("offers only panes that can submit input and are still tracked by the host", () => {
    terminals.set("pane-reader", "project-a");

    expect(
      service.filterOrchestratorPanes([
        { paneId: "pane-orch", ...ORCHESTRATOR },
        { paneId: "pane-reader", ...ORCHESTRATOR, tier: "workbench" },
        { paneId: "pane-exited", ...ORCHESTRATOR },
      ])
    ).toEqual(["pane-orch"]);
  });
});
