// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const { isWindowsMock } = vi.hoisted(() => ({ isWindowsMock: vi.fn<() => boolean>() }));
vi.mock("@/hooks/useHostPlatform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useHostPlatform")>()),
  useHostPlatform: () => ({ platform: isWindowsMock() ? "win32" : "darwin" }),
}));

import { TooltipProvider } from "@/components/ui/tooltip";
import { WorktreePathPicker } from "../WorktreePathPicker";

function renderPicker(): HTMLInputElement {
  render(
    <TooltipProvider>
      <WorktreePathPicker
        value=""
        onChange={() => {}}
        isGeneratingPath={false}
        onBrowseClick={() => {}}
      />
    </TooltipProvider>
  );
  return screen.getByTestId("worktree-path-input") as HTMLInputElement;
}

afterEach(() => {
  cleanup();
  isWindowsMock.mockReset();
});

describe("WorktreePathPicker placeholder", () => {
  it("shows a drive-letter path on Windows", () => {
    isWindowsMock.mockReturnValue(true);
    expect(renderPicker().placeholder).toMatch(/^[A-Z]:\\[^/]+$/);
  });

  it("shows a POSIX path elsewhere", () => {
    isWindowsMock.mockReturnValue(false);
    expect(renderPicker().placeholder).toMatch(/^\/[^\\]+$/);
  });
});
