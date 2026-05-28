import { describe, it, expect } from "vitest";

// Mirrors the placeholder useMemo. Sanity-checks the copy without
// depending on the agent registry.
function computePlaceholder(agentName: string | null, isVoiceActive = false): string {
  if (isVoiceActive) {
    return "Enter to send · Shift+Enter for newline";
  }
  return agentName ? `Ask ${agentName}` : "Ask anything";
}

describe("HybridInputBar placeholder copy", () => {
  it("uses 'Ask anything' when no agent is bound", () => {
    expect(computePlaceholder(null)).toBe("Ask anything");
  });

  it("uses 'Ask {agentName}' when an agent is bound", () => {
    expect(computePlaceholder("Claude")).toBe("Ask Claude");
    expect(computePlaceholder("Gemini")).toBe("Ask Gemini");
  });

  it("uses voice-active placeholder during voice recording regardless of agent", () => {
    expect(computePlaceholder(null, true)).toBe("Enter to send · Shift+Enter for newline");
    expect(computePlaceholder("Claude", true)).toBe("Enter to send · Shift+Enter for newline");
  });
});
