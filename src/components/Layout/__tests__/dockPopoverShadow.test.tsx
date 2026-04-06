import { describe, it, expect } from "vitest";

describe("Dock Popover Visual Layer - Issue #2316", () => {
  describe("Component Removal", () => {
    it("should not have DockPopupScrim component file", async () => {
      const fs = await import("fs/promises");
      const path = await import("path");

      const componentPath = path.resolve(__dirname, "../DockPopupScrim.tsx");
      const fileExists = await fs
        .access(componentPath)
        .then(() => true)
        .catch(() => false);

      expect(fileExists).toBe(false);
    });

    it("should not import DockPopupScrim in DockedTerminalItem", async () => {
      const fs = await import("fs/promises");
      const path = await import("path");

      const filePath = path.resolve(__dirname, "../DockedTerminalItem.tsx");
      const content = await fs.readFile(filePath, "utf-8");

      expect(content).not.toContain("DockPopupScrim");
    });

    it("should not import DockPopupScrim in DockedTabGroup", async () => {
      const fs = await import("fs/promises");
      const path = await import("path");

      const filePath = path.resolve(__dirname, "../DockedTabGroup.tsx");
      const content = await fs.readFile(filePath, "utf-8");

      expect(content).not.toContain("DockPopupScrim");
    });
  });

  describe("Shadow Token Usage", () => {
    it("should use --shadow-dock-panel-popover in DockedTerminalItem", async () => {
      const fs = await import("fs/promises");
      const path = await import("path");

      const filePath = path.resolve(__dirname, "../DockedTerminalItem.tsx");
      const content = await fs.readFile(filePath, "utf-8");

      expect(content).toContain("--shadow-dock-panel-popover");
    });

    it("should use --shadow-dock-panel-popover in DockedTabGroup", async () => {
      const fs = await import("fs/promises");
      const path = await import("path");

      const filePath = path.resolve(__dirname, "../DockedTabGroup.tsx");
      const content = await fs.readFile(filePath, "utf-8");

      expect(content).toContain("--shadow-dock-panel-popover");
    });
  });

  describe("Persistent Popover - Issue #3110", () => {
    it("should use onInteractOutside to prevent outside-click dismiss in DockedTerminalItem", async () => {
      const fs = await import("fs/promises");
      const path = await import("path");

      const filePath = path.resolve(__dirname, "../DockedTerminalItem.tsx");
      const content = await fs.readFile(filePath, "utf-8");

      expect(content).toContain("onInteractOutside");
      expect(content).toContain("handleDockInteractOutside");
    });

    it("should use onInteractOutside to prevent outside-click dismiss in DockedTabGroup", async () => {
      const fs = await import("fs/promises");
      const path = await import("path");

      const filePath = path.resolve(__dirname, "../DockedTabGroup.tsx");
      const content = await fs.readFile(filePath, "utf-8");

      expect(content).toContain("onInteractOutside");
      expect(content).toContain("handleDockInteractOutside");
    });

    it("should not unconditionally block Escape key in DockedTerminalItem", async () => {
      const fs = await import("fs/promises");
      const path = await import("path");

      const filePath = path.resolve(__dirname, "../DockedTerminalItem.tsx");
      const content = await fs.readFile(filePath, "utf-8");

      expect(content).not.toContain("onEscapeKeyDown={(e) => e.preventDefault()}");
      expect(content).toContain("onEscapeKeyDown");
      expect(content).toContain("handleDockEscapeKeyDown");
    });

    it("should not unconditionally block Escape key in DockedTabGroup", async () => {
      const fs = await import("fs/promises");
      const path = await import("path");

      const filePath = path.resolve(__dirname, "../DockedTabGroup.tsx");
      const content = await fs.readFile(filePath, "utf-8");

      expect(content).not.toContain("onEscapeKeyDown={(e) => e.preventDefault()}");
      expect(content).toContain("onEscapeKeyDown");
      expect(content).toContain("handleDockEscapeKeyDown");
    });
  });

  describe("Conditional Escape Key Guard - Issue #4572", () => {
    it("should export handleDockEscapeKeyDown from dockPopoverGuard", async () => {
      const fs = await import("fs/promises");
      const path = await import("path");

      const filePath = path.resolve(__dirname, "../dockPopoverGuard.ts");
      const content = await fs.readFile(filePath, "utf-8");

      expect(content).toContain("export function handleDockEscapeKeyDown");
    });

    it("handleDockEscapeKeyDown should conditionally call preventDefault based on portalContainer containment", async () => {
      const fs = await import("fs/promises");
      const path = await import("path");

      const filePath = path.resolve(__dirname, "../dockPopoverGuard.ts");
      const content = await fs.readFile(filePath, "utf-8");

      expect(content).toContain("portalContainer?.contains(document.activeElement)");
      expect(content).toContain("event.preventDefault()");
    });
  });
});
