import { describe, it, expect, beforeEach } from "vitest";
import { useClusterAttentionStore } from "../clusterAttentionStore";

function reset() {
  useClusterAttentionStore.setState({ dismissedSignatures: new Set<string>() });
}

describe("clusterAttentionStore", () => {
  beforeEach(() => {
    reset();
  });

  it("starts with an empty dismissed set", () => {
    expect(useClusterAttentionStore.getState().dismissedSignatures.size).toBe(0);
  });

  it("adds a signature on dismiss", () => {
    useClusterAttentionStore.getState().dismiss("prompt:a,b:100");
    const s = useClusterAttentionStore.getState();
    expect(s.dismissedSignatures.has("prompt:a,b:100")).toBe(true);
    expect(s.dismissedSignatures.size).toBe(1);
  });

  it("is idempotent when dismissing the same signature twice", () => {
    const { dismiss } = useClusterAttentionStore.getState();
    dismiss("sig-1");
    const firstRef = useClusterAttentionStore.getState().dismissedSignatures;
    dismiss("sig-1");
    const secondRef = useClusterAttentionStore.getState().dismissedSignatures;
    expect(secondRef).toBe(firstRef);
    expect(secondRef.size).toBe(1);
  });

  it("accumulates multiple distinct signatures", () => {
    const { dismiss } = useClusterAttentionStore.getState();
    dismiss("sig-a");
    dismiss("sig-b");
    dismiss("sig-c");
    const { dismissedSignatures } = useClusterAttentionStore.getState();
    expect(dismissedSignatures.size).toBe(3);
    expect([...dismissedSignatures].sort()).toEqual(["sig-a", "sig-b", "sig-c"]);
  });

  it("reset clears all signatures", () => {
    const { dismiss, reset: doReset } = useClusterAttentionStore.getState();
    dismiss("sig-a");
    dismiss("sig-b");
    doReset();
    expect(useClusterAttentionStore.getState().dismissedSignatures.size).toBe(0);
  });

  it("dismissing produces a new Set reference so subscribers re-render", () => {
    const before = useClusterAttentionStore.getState().dismissedSignatures;
    useClusterAttentionStore.getState().dismiss("sig-x");
    const after = useClusterAttentionStore.getState().dismissedSignatures;
    expect(after).not.toBe(before);
  });
});
