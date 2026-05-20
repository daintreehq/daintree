// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import {
  useFleetBroadcastConfirmStore,
  requestFleetBroadcastConfirmation,
  resolveFleetBroadcastConfirmation,
  __resetFleetBroadcastConfirmStoreForTesting,
} from "../fleetBroadcastConfirmStore";

beforeEach(() => {
  __resetFleetBroadcastConfirmStoreForTesting();
});

describe("fleetBroadcastConfirmStore", () => {
  describe("requestFleetBroadcastConfirmation", () => {
    it("sets pending with requestId, text, and warningReasons", () => {
      const promise = requestFleetBroadcastConfirmation({
        text: "rm -rf /",
        warningReasons: ["destructive"],
      }).catch(() => {});
      expect(promise).toBeInstanceOf(Promise);

      const { pending } = useFleetBroadcastConfirmStore.getState();
      expect(pending).not.toBeNull();
      expect(pending!.requestId).toBeTypeOf("string");
      expect(pending!.text).toBe("rm -rf /");
      expect(pending!.warningReasons).toEqual(["destructive"]);
    });

    it("produces JSON-serializable pending state (no functions)", () => {
      requestFleetBroadcastConfirmation({
        text: "rm -rf /",
        warningReasons: ["destructive"],
      }).catch(() => {});
      const { pending } = useFleetBroadcastConfirmStore.getState();
      const serialized = JSON.stringify(pending);
      const parsed = JSON.parse(serialized);
      expect(parsed.requestId).toBeTypeOf("string");
      expect(parsed.text).toBe("rm -rf /");
      expect(parsed.warningReasons).toEqual(["destructive"]);
      // Guard against regression: onConfirm must not exist on pending.
      // `divergence` is optional (omitted when absent serializes to undefined,
      // which JSON.stringify drops) — guard sorts on whatever keys survive.
      expect(Object.keys(parsed).sort()).toEqual(["requestId", "text", "warningReasons"].sort());
    });

    it("carries divergence targets when provided", () => {
      requestFleetBroadcastConfirmation({
        text: "deploy {{branch_name}}",
        warningReasons: [],
        divergence: {
          targets: [
            {
              terminalId: "t-1",
              title: "T1",
              payload: "deploy feature-x",
              overridden: false,
              skipped: false,
              unresolvedVars: [],
            },
            {
              terminalId: "t-2",
              title: "T2",
              payload: "deploy",
              overridden: false,
              skipped: false,
              unresolvedVars: ["branch_name"],
            },
          ],
        },
      }).catch(() => {});
      const { pending } = useFleetBroadcastConfirmStore.getState();
      expect(pending!.divergence?.targets).toHaveLength(2);
      expect(pending!.divergence?.targets[1]!.unresolvedVars).toEqual(["branch_name"]);
    });
  });

  describe("resolveFleetBroadcastConfirmation", () => {
    it("resolves the promise and clears pending", async () => {
      let resolved = false;
      requestFleetBroadcastConfirmation({
        text: "hello",
        warningReasons: ["multiline"],
      })
        .then(() => {
          resolved = true;
        })
        .catch(() => {});

      resolveFleetBroadcastConfirmation();

      // Promise microtask should fire synchronously after resolve
      await Promise.resolve();

      expect(resolved).toBe(true);
      expect(useFleetBroadcastConfirmStore.getState().pending).toBeNull();
    });

    it("is a no-op when no pending confirmation exists", () => {
      expect(() => resolveFleetBroadcastConfirmation()).not.toThrow();
    });

    it("is idempotent — second call is a no-op", async () => {
      let callCount = 0;
      requestFleetBroadcastConfirmation({
        text: "hello",
        warningReasons: [],
      })
        .then(() => {
          callCount++;
        })
        .catch(() => {});

      resolveFleetBroadcastConfirmation();
      resolveFleetBroadcastConfirmation();

      await Promise.resolve();
      expect(callCount).toBe(1);
    });
  });

  describe("clear (cancel)", () => {
    it("deletes the resolver so the promise never resolves", async () => {
      let resolved = false;
      requestFleetBroadcastConfirmation({
        text: "hello",
        warningReasons: [],
      })
        .then(() => {
          resolved = true;
        })
        .catch(() => {});

      useFleetBroadcastConfirmStore.getState().clear();
      expect(useFleetBroadcastConfirmStore.getState().pending).toBeNull();

      // resolve should be a no-op after clear
      resolveFleetBroadcastConfirmation();
      // Flush microtasks to catch any accidental resolution
      await Promise.resolve();
      expect(resolved).toBe(false);
    });

    it("is a safe no-op when nothing is pending", () => {
      expect(() => useFleetBroadcastConfirmStore.getState().clear()).not.toThrow();
    });
  });

  describe("supersede", () => {
    it("replaces a prior pending confirmation — old promise never resolves", async () => {
      let firstResolved = false;
      let secondResolved = false;

      requestFleetBroadcastConfirmation({
        text: "first",
        warningReasons: [],
      })
        .then(() => {
          firstResolved = true;
        })
        .catch(() => {});

      const firstId = useFleetBroadcastConfirmStore.getState().pending!.requestId;

      requestFleetBroadcastConfirmation({
        text: "second",
        warningReasons: [],
      })
        .then(() => {
          secondResolved = true;
        })
        .catch(() => {});

      const secondId = useFleetBroadcastConfirmStore.getState().pending!.requestId;
      expect(secondId).not.toBe(firstId);

      resolveFleetBroadcastConfirmation();
      await Promise.resolve();

      expect(firstResolved).toBe(false);
      expect(secondResolved).toBe(true);
    });
  });

  describe("resolveFleetBroadcastConfirmation when nothing pending", () => {
    it("does not throw", () => {
      expect(() => resolveFleetBroadcastConfirmation()).not.toThrow();
    });
  });
});
