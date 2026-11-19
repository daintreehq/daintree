// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionManifestEntry } from "@shared/types/actions";
import { __resetMcpConfirmStoreForTesting, useMcpConfirmStore } from "@/store/mcpConfirmStore";

const mocks = vi.hoisted(() => ({
  get: vi.fn((_id: string): ActionManifestEntry | null => null),
  dispatch: vi.fn(),
  getContext: vi.fn((): Record<string, unknown> => ({})),
}));

vi.mock("@/services/ActionService", () => ({
  actionService: {
    listForTransfer: () => [],
    getDispatchMeta: mocks.get,
    dispatch: mocks.dispatch,
    getContext: mocks.getContext,
  },
}));

import { resolveMcpConfirmPreviewTarget, tagMcpSpawnSource, useMcpBridge } from "../useMcpBridge";

const ADD: ActionManifestEntry = {
  id: "agent.addAccount",
  name: "agent.addAccount",
  title: "Add agent accounts",
  description: "Adds accounts.",
  category: "agent",
  kind: "command",
  danger: "confirm",
  enabled: true,
  requiresArgs: true,
};

/** Six Claude accounts and two Codex ones, as the issue asked for. */
const BATCH = Object.freeze({
  accounts: [
    { agentId: "claude", name: "google:me@example.com", folder: { kind: "create" } },
    ...["two", "three", "four", "five"].map((name) => ({
      agentId: "claude",
      name,
      folder: { kind: "create" },
    })),
    {
      agentId: "claude",
      name: "Shared",
      folder: { kind: "existing", path: "/Volumes/team/.claude-shared" },
    },
    { agentId: "codex", name: "Work", folder: { kind: "create" } },
    { agentId: "codex", name: "Lab", folder: { kind: "existing", path: "/Users/me/.codex-lab" } },
  ],
});

type DispatchPayload = {
  requestId: string;
  actionId: string;
  args?: unknown;
  confirmed?: boolean;
  authorization?: string;
  sessionOrigin?: "help" | "external";
};

describe("agent.addAccount through the MCP bridge (#17079)", () => {
  let dispatchHandler: ((payload: DispatchPayload) => void | Promise<void>) | undefined;
  let sendDispatchActionResponse: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    __resetMcpConfirmStoreForTesting();
    mocks.get.mockReturnValue(ADD);
    mocks.dispatch.mockResolvedValue({ ok: true, result: { accounts: [] } });
    dispatchHandler = undefined;
    sendDispatchActionResponse = vi.fn();
    Object.defineProperty(window, "electron", {
      configurable: true,
      writable: true,
      value: {
        mcpBridge: {
          onGetManifestRequest: () => vi.fn(),
          sendGetManifestResponse: vi.fn(),
          onDispatchActionRequest: (callback: (payload: DispatchPayload) => Promise<void>) => {
            dispatchHandler = callback;
            return vi.fn();
          },
          sendDispatchActionResponse,
        },
        mcpServer: {
          holdDispatch: vi.fn(async () => ({ held: true, remainingMs: 30_000 })),
        },
      },
    });
  });

  afterEach(() => {
    __resetMcpConfirmStoreForTesting();
  });

  function send(payload: Partial<DispatchPayload> = {}) {
    renderHook(() => useMcpBridge());
    return dispatchHandler?.({
      requestId: "req",
      actionId: "agent.addAccount",
      args: BATCH,
      sessionOrigin: "external",
      ...payload,
    });
  }

  it("asks once for the whole batch, a ticked row per account naming its folder", async () => {
    const dispatched = send();
    await vi.waitFor(() => expect(useMcpConfirmStore.getState().current).not.toBeNull());

    const pending = useMcpConfirmStore.getState().current;
    expect(pending?.previewPending).toBe(false);
    expect(pending?.subject).toBe("8 accounts");
    expect(pending?.selectionConfirmLabel).toEqual({
      verb: "Add",
      one: "account",
      many: "accounts",
    });
    expect(pending?.selectableTargets?.map((row) => row.detail)).toEqual([
      "New folder ~/.claude-google-me-example-com",
      "New folder ~/.claude-two",
      "New folder ~/.claude-three",
      "New folder ~/.claude-four",
      "New folder ~/.claude-five",
      "Existing folder /Volumes/team/.claude-shared",
      "New folder ~/.codex-work",
      "Existing folder /Users/me/.codex-lab",
    ]);
    expect(useMcpConfirmStore.getState().queue).toHaveLength(0);
    expect(mocks.dispatch).not.toHaveBeenCalled();

    useMcpConfirmStore.getState().resolveCurrent("rejected");
    await dispatched;
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it("dispatches the caller's own arguments with only the rows left ticked", async () => {
    const dispatched = send();
    await vi.waitFor(() => expect(useMcpConfirmStore.getState().current).not.toBeNull());

    useMcpConfirmStore.getState().resolveCurrent("approved", ["row-0", "row-6"]);
    await dispatched;

    // No spawn provenance or focus policy: the run plans its rows from these args.
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
    expect(mocks.dispatch).toHaveBeenCalledWith(
      "agent.addAccount",
      BATCH,
      expect.objectContaining({
        source: "agent",
        confirmed: true,
        hostApprovedTargets: [
          { id: "row-0", observedAgentRunning: false },
          { id: "row-6", observedAgentRunning: false },
        ],
      })
    );
  });

  it("puts a call that arrives confirmed to the person all the same", async () => {
    const dispatched = send({ confirmed: true, authorization: "skip-preference" });
    await vi.waitFor(() => expect(useMcpConfirmStore.getState().current).not.toBeNull());
    expect(mocks.dispatch).not.toHaveBeenCalled();

    useMcpConfirmStore.getState().resolveCurrent("approved", ["row-7"]);
    await dispatched;
    expect(mocks.dispatch).toHaveBeenCalledWith(
      "agent.addAccount",
      BATCH,
      expect.objectContaining({
        hostApprovedTargets: [{ id: "row-7", observedAgentRunning: false }],
      })
    );
  });

  it("refuses rows it can't plan before anyone is asked", async () => {
    await send({
      args: {
        accounts: [
          { agentId: "claude", name: "Team", folder: { kind: "create" } },
          { agentId: "claude", name: "team", folder: { kind: "create" } },
        ],
      },
    });

    expect(useMcpConfirmStore.getState().current).toBeNull();
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(sendDispatchActionResponse).toHaveBeenCalledWith({
      requestId: "req",
      result: {
        ok: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "Accounts 1 and 2 name the same folder. Nothing was added.",
        },
      },
    });
  });

  it("tags neither account action as a spawn, and previews only the add", () => {
    expect(tagMcpSpawnSource("agent.addAccount", BATCH, "help")).toBe(BATCH);
    const listing = { agentId: "claude" };
    expect(tagMcpSpawnSource("agent.listAccounts", listing, "help")).toBe(listing);
    expect(resolveMcpConfirmPreviewTarget("agent.addAccount", BATCH, undefined)?.kind).toBe(
      "agentAccountAdd"
    );
    expect(resolveMcpConfirmPreviewTarget("agent.addAccount", { accounts: [] }, undefined)).toBe(
      undefined
    );
  });
});
