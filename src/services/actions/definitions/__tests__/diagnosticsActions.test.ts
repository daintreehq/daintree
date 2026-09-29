import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import type { ActionCallbacks, ActionRegistry } from "../../actionTypes";

const mockCollect = vi.fn();

vi.mock("@/clients", () => ({
  systemClient: {
    collectDiagnosticsForReview: (...args: unknown[]) => mockCollect(...args),
  },
}));

vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));

describe("diagnostics.openReview", () => {
  const registry: ActionRegistry = new Map();
  let useDiagnosticsReviewStore: typeof import("@/store/diagnosticsReviewStore").useDiagnosticsReviewStore;

  beforeAll(async () => {
    const { registerDiagnosticsActions } = await import("../diagnosticsActions");
    // diagnostics.openReview reaches no callback; every one is a stub.
    const callbacks: ActionCallbacks = new Proxy(Object.create(null), { get: () => vi.fn() });
    registerDiagnosticsActions(registry, callbacks);
    ({ useDiagnosticsReviewStore } = await import("@/store/diagnosticsReviewStore"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    useDiagnosticsReviewStore.setState({
      isOpen: false,
      isCollecting: false,
      isSaving: false,
      reviewPayload: null,
      scope: null,
      downloadError: null,
    });
  });

  const run = (args?: unknown) => registry.get("diagnostics.openReview")!().run(args, {});

  it("opens the review with the collected snapshot", async () => {
    mockCollect.mockResolvedValue({ payload: {} });

    await run({ scope: { sections: ["logs"] } });

    const state = useDiagnosticsReviewStore.getState();
    expect(state.isOpen).toBe(true);
    expect(state.scope).toEqual({ sections: ["logs"] });
  });

  // A model caller reads a resolved dispatch as "the dialog is open".
  it("fails when collection fails instead of resolving with no dialog", async () => {
    mockCollect.mockRejectedValue(new Error("collector crashed"));

    await expect(run()).rejects.toThrow(/collector crashed/);
    expect(useDiagnosticsReviewStore.getState().isOpen).toBe(false);
  });

  it("does not fail when an open is already in flight", async () => {
    useDiagnosticsReviewStore.setState({ isCollecting: true });

    await expect(run()).resolves.toBeUndefined();
    expect(mockCollect).not.toHaveBeenCalled();
  });
});
