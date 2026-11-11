import { describe, expect, it } from "vitest";
import { ASSISTANT_SLOTS, MAX_ASSISTANT_SLOTS } from "../../config/assistantSlots.js";
import {
  AssistantListResultSchema,
  AssistantResumeArgsSchema,
  AssistantStartArgsSchema,
} from "../assistantControl.js";

describe("AssistantStartArgsSchema slot (#16218)", () => {
  it("takes every slot a project can hold, and none at all", () => {
    for (const slot of ASSISTANT_SLOTS) {
      expect(AssistantStartArgsSchema.safeParse({ slot }).success).toBe(true);
    }
    expect(AssistantStartArgsSchema.safeParse({}).success).toBe(true);
  });

  it("refuses a slot past the ceiling rather than clamping it", () => {
    for (const slot of [MAX_ASSISTANT_SLOTS, -1, 2.5, "1", null]) {
      expect(AssistantStartArgsSchema.safeParse({ slot }).success).toBe(false);
    }
  });
});

describe("AssistantResumeArgsSchema (#16763)", () => {
  it("takes one slot a project can hold, and needs it", () => {
    for (const slot of ASSISTANT_SLOTS) {
      expect(AssistantResumeArgsSchema.safeParse({ slot }).success).toBe(true);
    }
    for (const args of [
      {},
      { slot: MAX_ASSISTANT_SLOTS },
      { slot: -1 },
      { slot: 2.5 },
      { slot: "1" },
      { slot: [0, 1] },
    ]) {
      expect(AssistantResumeArgsSchema.safeParse(args).success).toBe(false);
    }
  });
});

describe("AssistantListResultSchema keptSlots (#16763)", () => {
  const listing = {
    projectId: "proj-1",
    assistants: [],
    vacantSlots: [0, 2],
    global: null,
  };

  it("is part of every listing, and names each kept slot's agent and when it was kept", () => {
    expect(AssistantListResultSchema.safeParse(listing).success).toBe(false);
    expect(
      AssistantListResultSchema.safeParse({
        ...listing,
        keptSlots: [{ slot: 1, agentId: "claude", capturedAt: 1_000 }],
      }).success
    ).toBe(true);
    const kept = { slot: 1, agentId: "claude", capturedAt: 1_000 };
    for (const field of ["slot", "agentId", "capturedAt"] as const) {
      const { [field]: _dropped, ...rest } = kept;
      expect(
        AssistantListResultSchema.safeParse({ ...listing, keptSlots: [rest] }).success,
        field
      ).toBe(false);
    }
    expect(
      AssistantListResultSchema.safeParse({
        ...listing,
        keptSlots: [{ ...kept, capturedAt: "yesterday" }],
      }).success
    ).toBe(false);
  });
});
