// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/store/panelStore", () => ({
  usePanelStore: {
    getState: () => ({ panelsById: { p1: { id: "p1", title: "Notes" } } }),
  },
}));

import { PluginPanelCloseGuardHost } from "../PluginPanelCloseGuardHost";
import {
  __resetPanelCloseGuardsForTests,
  consultPanelCloseGuards,
  hasPanelCloseGuard,
} from "@/services/panelCloseGuard";
import {
  resetPluginPanelLifecycleForTests,
  setViewUnsavedChanges,
} from "@/services/plugin/pluginPanelLifecycle";
import { TooltipProvider } from "@/components/ui/tooltip";

const owner = {};

function renderHost() {
  return render(
    <TooltipProvider>
      <PluginPanelCloseGuardHost />
    </TooltipProvider>
  );
}

function setDirty(dirty: boolean) {
  act(() => {
    setViewUnsavedChanges("p1", owner, dirty);
  });
}

beforeEach(() => {
  __resetPanelCloseGuardsForTests();
  resetPluginPanelLifecycleForTests();
});

afterEach(() => {
  cleanup();
  __resetPanelCloseGuardsForTests();
  resetPluginPanelLifecycleForTests();
});

describe("PluginPanelCloseGuardHost (#13815)", () => {
  it("guards exactly the panels whose view reports unsaved work", () => {
    renderHost();
    expect(hasPanelCloseGuard("p1")).toBe(false);
    setDirty(true);
    expect(hasPanelCloseGuard("p1")).toBe(true);
    setDirty(false);
    expect(hasPanelCloseGuard("p1")).toBe(false);
  });

  it("Cancel keeps the panel, Discard lets the close through", async () => {
    renderHost();
    setDirty(true);

    let verdict = consultPanelCloseGuards(["p1"]);
    expect(await screen.findByText("Discard unsaved changes in 'Notes'?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await expect(verdict).resolves.toBe(false);
    await waitFor(() => expect(screen.queryByTestId("plugin-panel-close-prompt")).toBeNull());

    verdict = consultPanelCloseGuards(["p1"]);
    await screen.findByRole("button", { name: "Discard changes" });
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    await expect(verdict).resolves.toBe(true);
  });

  it("answers Cancel when the panel stops being dirty under an open prompt", async () => {
    renderHost();
    setDirty(true);
    const verdict = consultPanelCloseGuards(["p1"]);
    await screen.findByRole("button", { name: "Discard changes" });
    setDirty(false);
    await expect(verdict).resolves.toBe(false);
    await waitFor(() => expect(screen.queryByTestId("plugin-panel-close-prompt")).toBeNull());
  });
});
