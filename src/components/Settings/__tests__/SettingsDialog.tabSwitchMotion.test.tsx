// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { act, renderHook } from "@testing-library/react";
import { usePanelSettled } from "../SettingsDialog";

// Switching settings tabs must never animate. A revealed panel's values are still
// arriving and its measured controls are settling out of `display: none`, so every
// transition inside it stays off until the user interacts with that visit of it.

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => fs.readFileSync(path.resolve(TEST_DIR, rel), "utf8");

const eventOn = (target: Element) => ({ target });

describe("usePanelSettled", () => {
  const control = document.createElement("button");

  it("settles only once the user interacts with the visible panel", () => {
    const { result } = renderHook(() => usePanelSettled("a"));
    expect(result.current[0]).toBe(false);

    act(() => result.current[1](eventOn(control)));

    expect(result.current[0]).toBe(true);
  });

  it("settles again on a return to a panel that was settled before", () => {
    const { result, rerender } = renderHook(({ visit }) => usePanelSettled(visit), {
      initialProps: { visit: "a" },
    });
    act(() => result.current[1](eventOn(control)));

    rerender({ visit: "b" });
    expect(result.current[0]).toBe(false);
    rerender({ visit: "a" });

    expect(result.current[0]).toBe(false);
  });

  it("does not count a tab click as interacting with the panel", () => {
    const tab = document.createElement("button");
    tab.setAttribute("role", "tab");
    const { result } = renderHook(() => usePanelSettled("a"));

    act(() => result.current[1](eventOn(tab)));

    expect(result.current[0]).toBe(false);
  });
});

describe("settings panel motion guard wiring", () => {
  it("guards every settings tab panel", () => {
    const panels = read("../SettingsDialog.tsx").split('role="tabpanel"').slice(1);

    expect(panels.length).toBeGreaterThan(0);
    for (const panel of panels) {
      expect(panel.slice(0, panel.indexOf(">"))).toContain(
        'data-settings-settling={isActive && panelSettled ? undefined : ""}'
      );
    }
  });

  it("turns transitions off inside a settling panel", () => {
    expect(read("../../../styles/components/settings.css")).toMatch(
      /\[data-settings-settling\] \*,[^{]*\{\s*transition: none !important;/
    );
  });
});
