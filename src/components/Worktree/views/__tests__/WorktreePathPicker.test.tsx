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

function renderPicker(value = ""): HTMLInputElement {
  render(
    <TooltipProvider>
      <WorktreePathPicker
        value={value}
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

describe("WorktreePathPicker tail", () => {
  const path = "/Users/someone/My  Projects/daintree-worktrees/feature-issue-15356-a-long-branch";

  it("renders the path as a PathTail over the input's own text", () => {
    isWindowsMock.mockReturnValue(false);
    const input = renderPicker(path);
    const tail = input.parentElement!.querySelector(".path-tail")!;
    expect(tail.textContent).toBe(path);
    // An input keeps runs of spaces; the painted copy has to as well.
    expect(tail.classList.contains("whitespace-pre")).toBe(true);
    expect(tail.querySelector("bdi")?.getAttribute("dir")).toBe("ltr");
    // The input stays the accessible field; the painted copy is hidden from AT.
    expect(tail.closest("[aria-hidden='true']")).not.toBeNull();
    expect(input.value).toBe(path);
    expect(input.className).toContain("text-transparent");
    expect(input.className).toContain("focus:text-text-primary");
  });

  it("leaves an empty field to its placeholder", () => {
    isWindowsMock.mockReturnValue(false);
    const input = renderPicker();
    expect(input.parentElement!.querySelector(".path-tail")).toBeNull();
    expect(input.className).not.toContain("text-transparent");
  });
});
