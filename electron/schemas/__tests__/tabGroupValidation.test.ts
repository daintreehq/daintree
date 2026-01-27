import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { sanitizeTabGroups, TabGroupInputSchema } from "../ipc.js";

describe("TabGroupInputSchema", () => {
  it("should validate a valid tab group", () => {
    const validGroup = {
      id: "group-1",
      location: "grid" as const,
      activeTabId: "panel-1",
      panelIds: ["panel-1", "panel-2"],
    };

    const result = TabGroupInputSchema.safeParse(validGroup);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(validGroup);
    }
  });

  it("should validate tab group with optional worktreeId", () => {
    const validGroup = {
      id: "group-1",
      location: "dock" as const,
      worktreeId: "worktree-123",
      activeTabId: "panel-1",
      panelIds: ["panel-1", "panel-2"],
    };

    const result = TabGroupInputSchema.safeParse(validGroup);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.worktreeId).toBe("worktree-123");
    }
  });

  it("should preserve unknown fields (passthrough)", () => {
    const groupWithExtra = {
      id: "group-1",
      location: "grid" as const,
      activeTabId: "panel-1",
      panelIds: ["panel-1", "panel-2"],
      customField: "custom-value",
      futureFlag: true,
    };

    const result = TabGroupInputSchema.safeParse(groupWithExtra);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toHaveProperty("customField", "custom-value");
      expect(result.data).toHaveProperty("futureFlag", true);
    }
  });

  it("should reject tab group with empty id", () => {
    const invalidGroup = {
      id: "",
      location: "grid" as const,
      activeTabId: "panel-1",
      panelIds: ["panel-1"],
    };

    const result = TabGroupInputSchema.safeParse(invalidGroup);
    expect(result.success).toBe(false);
  });

  it("should reject tab group with invalid location", () => {
    const invalidGroup = {
      id: "group-1",
      location: "trash",
      activeTabId: "panel-1",
      panelIds: ["panel-1"],
    };

    const result = TabGroupInputSchema.safeParse(invalidGroup);
    expect(result.success).toBe(false);
  });

  it("should reject tab group with non-array panelIds", () => {
    const invalidGroup = {
      id: "group-1",
      location: "grid" as const,
      activeTabId: "panel-1",
      panelIds: "not-an-array",
    };

    const result = TabGroupInputSchema.safeParse(invalidGroup);
    expect(result.success).toBe(false);
  });

  it("should reject tab group missing required fields", () => {
    const invalidGroup = {
      id: "group-1",
      location: "grid" as const,
    };

    const result = TabGroupInputSchema.safeParse(invalidGroup);
    expect(result.success).toBe(false);
  });
});

describe("sanitizeTabGroups", () => {
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
    consoleLogSpy.mockRestore();
  });

  describe("input validation", () => {
    it("should return empty array for null input", () => {
      const result = sanitizeTabGroups(null, "test-context");
      expect(result).toEqual([]);
      expect(consoleWarnSpy).not.toHaveBeenCalled();
    });

    it("should return empty array for undefined input", () => {
      const result = sanitizeTabGroups(undefined, "test-context");
      expect(result).toEqual([]);
      expect(consoleWarnSpy).not.toHaveBeenCalled();
    });

    it("should warn and return empty array for non-array input", () => {
      const result = sanitizeTabGroups("not-an-array" as any, "test-context");
      expect(result).toEqual([]);
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        "[TabGroups:test-context] Expected array but received string"
      );
    });
  });

  describe("valid tab groups", () => {
    it("should pass through valid tab groups unchanged", () => {
      const validGroups = [
        {
          id: "group-1",
          location: "grid" as const,
          activeTabId: "panel-1",
          panelIds: ["panel-1", "panel-2"],
        },
        {
          id: "group-2",
          location: "dock" as const,
          activeTabId: "panel-3",
          panelIds: ["panel-3", "panel-4", "panel-5"],
        },
      ];

      const result = sanitizeTabGroups(validGroups, "test-project");
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual(validGroups[0]);
      expect(result[1]).toEqual(validGroups[1]);
    });

    it("should preserve worktreeId when present", () => {
      const groups = [
        {
          id: "group-1",
          location: "grid" as const,
          worktreeId: "worktree-123",
          activeTabId: "panel-1",
          panelIds: ["panel-1", "panel-2"],
        },
      ];

      const result = sanitizeTabGroups(groups, "test-project");
      expect(result[0].worktreeId).toBe("worktree-123");
    });
  });

  describe("invalid groups filtering", () => {
    it("should drop groups with empty id", () => {
      const groups = [
        {
          id: "",
          location: "grid" as const,
          activeTabId: "panel-1",
          panelIds: ["panel-1", "panel-2"],
        },
      ];

      const result = sanitizeTabGroups(groups, "test-project");
      expect(result).toHaveLength(0);
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Dropping invalid group"),
        expect.anything()
      );
    });

    it("should drop groups with invalid location", () => {
      const groups = [
        {
          id: "group-1",
          location: "trash" as any,
          activeTabId: "panel-1",
          panelIds: ["panel-1", "panel-2"],
        },
      ];

      const result = sanitizeTabGroups(groups, "test-project");
      expect(result).toHaveLength(0);
      expect(consoleWarnSpy).toHaveBeenCalled();
    });

    it("should drop groups missing required fields", () => {
      const groups = [
        {
          id: "group-1",
          location: "grid" as const,
          // Missing activeTabId and panelIds
        } as any,
      ];

      const result = sanitizeTabGroups(groups, "test-project");
      expect(result).toHaveLength(0);
      expect(consoleWarnSpy).toHaveBeenCalled();
    });

    it("should use group id in warning when available", () => {
      const groups = [
        {
          id: "my-invalid-group",
          location: "invalid" as any,
          activeTabId: "panel-1",
          panelIds: ["panel-1", "panel-2"],
        },
      ];

      sanitizeTabGroups(groups, "test-project");
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining("my-invalid-group"),
        expect.anything()
      );
    });

    it("should use index in warning when id not available", () => {
      const groups = [
        {
          location: "grid" as const,
          activeTabId: "panel-1",
          panelIds: ["panel-1", "panel-2"],
        } as any,
      ];

      sanitizeTabGroups(groups, "test-project");
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining("index-0"),
        expect.anything()
      );
    });
  });

  describe("panelIds sanitization", () => {
    it("should drop groups with non-string panelIds due to schema validation", () => {
      const groups = [
        {
          id: "group-1",
          location: "grid" as const,
          activeTabId: "panel-1",
          panelIds: ["panel-1", 123 as any, "panel-2", null as any, undefined as any],
        },
      ];

      const result = sanitizeTabGroups(groups, "test-project");
      expect(result).toHaveLength(0);
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Dropping invalid group"),
        expect.anything()
      );
    });

    it("should filter out empty string panelIds", () => {
      const groups = [
        {
          id: "group-1",
          location: "grid" as const,
          activeTabId: "panel-1",
          panelIds: ["panel-1", "", "panel-2", "   "],
        },
      ];

      const result = sanitizeTabGroups(groups, "test-project");
      expect(result[0].panelIds).toEqual(["panel-1", "panel-2", "   "]);
    });

    it("should deduplicate panelIds while preserving order", () => {
      const groups = [
        {
          id: "group-1",
          location: "grid" as const,
          activeTabId: "panel-1",
          panelIds: ["panel-1", "panel-2", "panel-1", "panel-3", "panel-2"],
        },
      ];

      const result = sanitizeTabGroups(groups, "test-project");
      expect(result[0].panelIds).toEqual(["panel-1", "panel-2", "panel-3"]);
    });
  });

  describe("single-panel group filtering", () => {
    it("should drop groups with exactly 1 panel", () => {
      const groups = [
        {
          id: "group-1",
          location: "grid" as const,
          activeTabId: "panel-1",
          panelIds: ["panel-1"],
        },
      ];

      const result = sanitizeTabGroups(groups, "test-project");
      expect(result).toHaveLength(0);
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining("Dropping group group-1 with 1 valid unique panel(s)")
      );
    });

    it("should drop groups with 0 panels", () => {
      const groups = [
        {
          id: "group-1",
          location: "grid" as const,
          activeTabId: "panel-1",
          panelIds: [],
        },
      ];

      const result = sanitizeTabGroups(groups, "test-project");
      expect(result).toHaveLength(0);
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining("Dropping group group-1 with 0 valid unique panel(s)")
      );
    });

    it("should drop groups with duplicates that reduce to 1 panel", () => {
      const groups = [
        {
          id: "group-1",
          location: "grid" as const,
          activeTabId: "panel-1",
          panelIds: ["panel-1", "panel-1", "panel-1"],
        },
      ];

      const result = sanitizeTabGroups(groups, "test-project");
      expect(result).toHaveLength(0);
    });

    it("should drop groups with invalid panelIds that reduce to 1 panel", () => {
      const groups = [
        {
          id: "group-1",
          location: "grid" as const,
          activeTabId: "panel-1",
          panelIds: ["panel-1", "" as any, null as any, 123 as any],
        },
      ];

      const result = sanitizeTabGroups(groups, "test-project");
      expect(result).toHaveLength(0);
    });

    it("should keep groups with 2+ valid unique panels", () => {
      const groups = [
        {
          id: "group-1",
          location: "grid" as const,
          activeTabId: "panel-1",
          panelIds: ["panel-1", "panel-2"],
        },
      ];

      const result = sanitizeTabGroups(groups, "test-project");
      expect(result).toHaveLength(1);
    });
  });

  describe("activeTabId repair", () => {
    it("should keep valid activeTabId that exists in panelIds", () => {
      const groups = [
        {
          id: "group-1",
          location: "grid" as const,
          activeTabId: "panel-2",
          panelIds: ["panel-1", "panel-2", "panel-3"],
        },
      ];

      const result = sanitizeTabGroups(groups, "test-project");
      expect(result[0].activeTabId).toBe("panel-2");
    });

    it("should fallback to first panel when activeTabId is missing (optional)", () => {
      const groups = [
        {
          id: "group-1",
          location: "grid" as const,
          panelIds: ["panel-1", "panel-2", "panel-3"],
        } as any,
      ];

      const result = sanitizeTabGroups(groups, "test-project");
      expect(result[0].activeTabId).toBe("panel-1");
    });

    it("should fallback to first panel when activeTabId not in panelIds", () => {
      const groups = [
        {
          id: "group-1",
          location: "grid" as const,
          activeTabId: "panel-99",
          panelIds: ["panel-1", "panel-2", "panel-3"],
        },
      ];

      const result = sanitizeTabGroups(groups, "test-project");
      expect(result[0].activeTabId).toBe("panel-1");
    });

    it("should fallback when activeTabId was removed during deduplication", () => {
      const groups = [
        {
          id: "group-1",
          location: "grid" as const,
          activeTabId: "panel-2",
          panelIds: ["panel-1", "panel-2", "panel-2"],
        },
      ];

      const result = sanitizeTabGroups(groups, "test-project");
      expect(result[0].activeTabId).toBe("panel-2");
    });
  });

  describe("summary logging", () => {
    it("should log summary when groups are dropped", () => {
      const groups = [
        {
          id: "valid-1",
          location: "grid" as const,
          activeTabId: "panel-1",
          panelIds: ["panel-1", "panel-2"],
        },
        {
          id: "invalid-1",
          location: "trash" as any,
          activeTabId: "panel-3",
          panelIds: ["panel-3", "panel-4"],
        },
        {
          id: "single-panel",
          location: "grid" as const,
          activeTabId: "panel-5",
          panelIds: ["panel-5"],
        },
      ];

      sanitizeTabGroups(groups, "test-project");
      expect(consoleLogSpy).toHaveBeenCalledWith(
        "[TabGroups:test-project] Sanitization summary: 1 valid, 2 dropped"
      );
    });

    it("should not log summary when no groups are dropped", () => {
      const groups = [
        {
          id: "valid-1",
          location: "grid" as const,
          activeTabId: "panel-1",
          panelIds: ["panel-1", "panel-2"],
        },
        {
          id: "valid-2",
          location: "dock" as const,
          activeTabId: "panel-3",
          panelIds: ["panel-3", "panel-4"],
        },
      ];

      consoleLogSpy.mockClear();
      sanitizeTabGroups(groups, "test-project");
      expect(consoleLogSpy).not.toHaveBeenCalledWith(
        expect.stringContaining("Sanitization summary")
      );
    });
  });

  describe("complex scenarios", () => {
    it("should handle mixed valid and invalid groups", () => {
      const groups = [
        {
          id: "valid-1",
          location: "grid" as const,
          activeTabId: "panel-1",
          panelIds: ["panel-1", "panel-2"],
        },
        {
          id: "invalid-location",
          location: "invalid" as any,
          activeTabId: "panel-3",
          panelIds: ["panel-3", "panel-4"],
        },
        {
          id: "valid-2",
          location: "dock" as const,
          activeTabId: "panel-5",
          panelIds: ["panel-5", "panel-6", "panel-7"],
        },
        {
          id: "single-panel",
          location: "grid" as const,
          activeTabId: "panel-8",
          panelIds: ["panel-8"],
        },
      ];

      const result = sanitizeTabGroups(groups, "test-project");
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe("valid-1");
      expect(result[1].id).toBe("valid-2");
    });

    it("should handle groups with duplicate panelIds and invalid activeTabId", () => {
      const groups = [
        {
          id: "group-1",
          location: "grid" as const,
          activeTabId: "panel-99",
          panelIds: ["panel-1", "panel-2", "panel-1", "panel-3", "panel-2"],
        },
      ];

      const result = sanitizeTabGroups(groups, "test-project");
      expect(result).toHaveLength(1);
      expect(result[0].panelIds).toEqual(["panel-1", "panel-2", "panel-3"]);
      expect(result[0].activeTabId).toBe("panel-1");
    });

    it("should preserve unknown fields through sanitization", () => {
      const groups = [
        {
          id: "group-1",
          location: "grid" as const,
          activeTabId: "panel-1",
          panelIds: ["panel-1", "panel-2"],
          customField: "custom-value",
          futureFlag: true,
        },
      ];

      const result = sanitizeTabGroups(groups, "test-project");
      expect(result[0]).toHaveProperty("customField", "custom-value");
      expect(result[0]).toHaveProperty("futureFlag", true);
    });

    it("should handle empty array input", () => {
      const result = sanitizeTabGroups([], "test-project");
      expect(result).toEqual([]);
    });

    it("should handle large number of groups", () => {
      const groups = Array.from({ length: 100 }, (_, i) => ({
        id: `group-${i}`,
        location: i % 2 === 0 ? ("grid" as const) : ("dock" as const),
        activeTabId: `panel-${i * 2}`,
        panelIds: [`panel-${i * 2}`, `panel-${i * 2 + 1}`],
      }));

      const result = sanitizeTabGroups(groups, "test-project");
      expect(result).toHaveLength(100);
    });
  });
});
