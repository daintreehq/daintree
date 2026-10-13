import { describe, it, expect } from "vitest";

describe("Dock Popover Visual Layer - Issue #2316", () => {
  describe("Neutral Lift on Popover-Open Dock Buttons - Issue #5928", () => {
    const dockButtonFiles = [
      "../StatusContainer.tsx",
      "../BackgroundContainer.tsx",
      "../TrashContainer.tsx",
    ];

    for (const relativePath of dockButtonFiles) {
      it(`should not use accent ring on isOpen state in ${relativePath}`, async () => {
        const fs = await import("fs/promises");
        const path = await import("path");

        const filePath = path.resolve(__dirname, relativePath);
        const content = await fs.readFile(filePath, "utf-8");

        expect(content).not.toContain("ring-accent-primary");
        expect(content).not.toContain("border-daintree-accent/40");
      });

      it(`should use neutral lift tokens on isOpen state in ${relativePath}`, async () => {
        const fs = await import("fs/promises");
        const path = await import("path");

        const filePath = path.resolve(__dirname, relativePath);
        const content = await fs.readFile(filePath, "utf-8");

        expect(content).toContain("isOpen && DOCK_STATUS_PILL_OPEN_CLASS");
      });
    }

    it("defines the shared open lift from neutral tokens", async () => {
      const { DOCK_STATUS_PILL_OPEN_CLASS } = await import("../dockStatusPill");
      expect(DOCK_STATUS_PILL_OPEN_CLASS).toContain("bg-overlay-emphasis");
      expect(DOCK_STATUS_PILL_OPEN_CLASS).not.toContain("accent");
    });
  });
});
