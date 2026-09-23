// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { usePreferencesStore } from "@/store/preferencesStore";
import { FileBrowserVisibilitySettings } from "../FileBrowserVisibilitySettings";

// Captured from the store at runtime (not imported from source) so the reset
// assertion below is a behavioral check, not a copy of the default literal.
let defaults: string[];

function patterns(): string[] {
  return usePreferencesStore.getState().fileBrowserAlwaysHiddenPatterns;
}

describe("FileBrowserVisibilitySettings", () => {
  beforeAll(() => {
    usePreferencesStore.getState().resetFileBrowserAlwaysHiddenPatterns();
    defaults = [...patterns()];
  });

  beforeEach(() => {
    usePreferencesStore.getState().setFileBrowserAlwaysHiddenPatterns([".DS_Store", "Thumbs.db"]);
  });

  it("renders a removable chip for each current pattern", () => {
    render(<FileBrowserVisibilitySettings />);
    expect(screen.getByLabelText("Remove .DS_Store")).toBeTruthy();
    expect(screen.getByLabelText("Remove Thumbs.db")).toBeTruthy();
  });

  it("adds a pattern on Enter and clears the input", () => {
    render(<FileBrowserVisibilitySettings />);
    const input = screen.getByLabelText("Add an always-hidden pattern") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "*.log" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(patterns()).toEqual([".DS_Store", "Thumbs.db", "*.log"]);
    expect(input.value).toBe("");
  });

  it("adds a pattern via the Add button", () => {
    render(<FileBrowserVisibilitySettings />);
    const input = screen.getByLabelText("Add an always-hidden pattern");

    fireEvent.change(input, { target: { value: "desktop.ini" } });
    fireEvent.click(screen.getByLabelText("Add pattern"));

    expect(patterns()).toContain("desktop.ini");
  });

  it("removes the pattern whose chip button is clicked", () => {
    render(<FileBrowserVisibilitySettings />);

    fireEvent.click(screen.getByLabelText("Remove .DS_Store"));

    expect(patterns()).toEqual(["Thumbs.db"]);
  });

  it("rejects a slash-containing pattern with an error and does not add it", () => {
    render(<FileBrowserVisibilitySettings />);
    const input = screen.getByLabelText("Add an always-hidden pattern");

    fireEvent.change(input, { target: { value: "build/output" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(screen.getByText("Match by name only — no slashes")).toBeTruthy();
    expect(patterns()).toEqual([".DS_Store", "Thumbs.db"]);
  });

  it("shows the empty affordance when nothing is hidden", () => {
    usePreferencesStore.getState().setFileBrowserAlwaysHiddenPatterns([]);
    render(<FileBrowserVisibilitySettings />);

    expect(screen.getByText("Add a name or pattern to always hide it")).toBeTruthy();
  });

  it("refuses to add past the cap and keeps the draft instead of silently dropping it", () => {
    const full = Array.from({ length: 100 }, (_, i) => `pat-${i}`);
    usePreferencesStore.getState().setFileBrowserAlwaysHiddenPatterns(full);
    render(<FileBrowserVisibilitySettings />);
    const input = screen.getByLabelText("Add an always-hidden pattern") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "one-more" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(screen.getByText("List is full — remove one first")).toBeTruthy();
    expect(patterns()).not.toContain("one-more");
    expect(input.value).toBe("one-more");
  });

  it("offers reset only when modified, and restores the defaults", () => {
    // beforeEach left a custom list, which differs from defaults.
    render(<FileBrowserVisibilitySettings />);

    fireEvent.click(screen.getByLabelText("Reset always-hidden patterns to defaults"));

    expect(patterns()).toEqual(defaults);
    expect(screen.queryByLabelText("Reset always-hidden patterns to defaults")).toBeNull();
  });

  it("keeps focus in the list when a chip is removed, and falls back to the add field", () => {
    render(<FileBrowserVisibilitySettings />);
    const [first, second] = patterns();

    fireEvent.click(screen.getByLabelText(`Remove ${first}`));
    expect(document.activeElement).toBe(screen.getByLabelText(`Remove ${second}`));

    fireEvent.click(screen.getByLabelText(`Remove ${second}`));
    expect(document.activeElement).toBe(screen.getByLabelText("Add an always-hidden pattern"));
  });
});
