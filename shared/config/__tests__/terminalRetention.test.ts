import { describe, expect, it } from "vitest";
import type { AgentState } from "../../types/agent.js";
import {
  computeRetentionTier,
  TERMINAL_RETENTION_BUDGETS,
  type RetentionTierInputs,
} from "../terminalRetention.js";

function inputs(overrides: Partial<RetentionTierInputs> = {}): RetentionTierInputs {
  return {
    isAgentTerminal: true,
    agentState: undefined,
    isFocused: false,
    activityTier: "background",
    isTrashed: false,
    hasPreservedSnapshot: false,
    isExited: false,
    ...overrides,
  };
}

describe("computeRetentionTier", () => {
  describe("agent states", () => {
    it.each([
      ["working", "foreground", "working"],
      ["directing", "foreground", "working"],
    ] as Array<[AgentState, string, string]>)(
      "%s agent: foreground when visible, working when backgrounded",
      (state, visibleTier, backgroundTier) => {
        expect(computeRetentionTier(inputs({ agentState: state, activityTier: "active" }))).toBe(
          visibleTier
        );
        expect(
          computeRetentionTier(inputs({ agentState: state, activityTier: "background" }))
        ).toBe(backgroundTier);
      }
    );

    it.each(["idle", "waiting", "completed", "exited"] as AgentState[])(
      "%s agent settles to lower retention unless focused",
      (state) => {
        expect(computeRetentionTier(inputs({ agentState: state }))).toBe("settled");
        // Visibility alone is not enough for a settled agent — only focus
        // keeps full retention (avoids trim churn on the interacted pane).
        expect(computeRetentionTier(inputs({ agentState: state, activityTier: "active" }))).toBe(
          "settled"
        );
        expect(
          computeRetentionTier(
            inputs({ agentState: state, isFocused: true, activityTier: "active" })
          )
        ).toBe("foreground");
      }
    );

    it("a focused working agent is foreground even if its activity tier lags at background", () => {
      expect(
        computeRetentionTier(
          inputs({ agentState: "working", isFocused: true, activityTier: "background" })
        )
      ).toBe("foreground");
    });
  });

  describe("terminal lifecycle overrides", () => {
    it("trashed terminals are archived regardless of agent state or focus", () => {
      expect(
        computeRetentionTier(
          inputs({
            isTrashed: true,
            agentState: "working",
            isFocused: true,
            activityTier: "active",
          })
        )
      ).toBe("archived");
    });

    it("preserved-snapshot terminals are archived", () => {
      expect(computeRetentionTier(inputs({ hasPreservedSnapshot: true }))).toBe("archived");
    });

    it("an exited terminal without a preserved snapshot is settled", () => {
      expect(
        computeRetentionTier(inputs({ isExited: true, agentState: "working", isFocused: true }))
      ).toBe("settled");
    });
  });

  describe("plain terminals", () => {
    it("visible or focused plain shells keep foreground retention", () => {
      expect(computeRetentionTier(inputs({ isAgentTerminal: false, activityTier: "active" }))).toBe(
        "foreground"
      );
      expect(computeRetentionTier(inputs({ isAgentTerminal: false, isFocused: true }))).toBe(
        "foreground"
      );
    });

    it("background plain shells settle", () => {
      expect(computeRetentionTier(inputs({ isAgentTerminal: false }))).toBe("settled");
    });
  });
});

describe("TERMINAL_RETENTION_BUDGETS", () => {
  it("budgets are monotonically non-increasing from foreground to archived", () => {
    const order = ["foreground", "working", "settled", "archived"] as const;
    for (let i = 1; i < order.length; i++) {
      const prev = TERMINAL_RETENTION_BUDGETS[order[i - 1]!];
      const next = TERMINAL_RETENTION_BUDGETS[order[i]!];
      expect(next.mirrorScrollbackLines).toBeLessThanOrEqual(prev.mirrorScrollbackLines);
      expect(next.pressureMirrorFloorLines).toBeLessThanOrEqual(prev.pressureMirrorFloorLines);
      expect(next.semanticBufferLines).toBeLessThanOrEqual(prev.semanticBufferLines);
      expect(next.forensicsChars).toBeLessThanOrEqual(prev.forensicsChars);
      expect(next.agentOutputChars).toBeLessThanOrEqual(prev.agentOutputChars);
    }
  });

  it("every tier's pressure floor stays within its steady-state cap", () => {
    for (const budget of Object.values(TERMINAL_RETENTION_BUDGETS)) {
      expect(budget.pressureMirrorFloorLines).toBeLessThanOrEqual(budget.mirrorScrollbackLines);
      expect(budget.pressureMirrorFloorLines).toBeGreaterThan(0);
    }
  });
});
