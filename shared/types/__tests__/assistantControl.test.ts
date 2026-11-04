import { describe, expect, it } from "vitest";
import { ASSISTANT_SLOTS, MAX_ASSISTANT_SLOTS } from "../../config/assistantSlots.js";
import { AssistantStartArgsSchema } from "../assistantControl.js";

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
