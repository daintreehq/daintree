// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@shared/types/project";
import type { PresentationLevels } from "@shared/config/presentationProfile";
import { useProjectStore } from "@/store/projectStore";
import {
  _resetProjectPresentationStoreForTest,
  useProjectPresentationStore,
} from "@/store/projectPresentationStore";
import { useToolbarPreferencesStore } from "@/store/toolbarPreferencesStore";
import { ProjectToolbarProfileNotice, ProjectToolbarResetRow } from "../ProjectToolbarProfileNotice";

const PROJECT: Project = {
  id: "a".repeat(64),
  name: "Repo",
  path: "/repo",
  emoji: "",
  lastOpened: 0,
  gitBacked: true,
};

function applyProfile(
  levels: PresentationLevels,
  extra: { useProjectToolbar?: boolean | null; promotedPluginButtons?: string[] } = {}
) {
  act(() => {
    useProjectPresentationStore.setState({
      loaded: true,
      projectId: PROJECT.id,
      levels,
      useProjectToolbar: extra.useProjectToolbar ?? null,
      promotedPluginButtons: extra.promotedPluginButtons ?? [],
    });
  });
}

const notice = () => document.querySelector('[data-testid="project-toolbar-notice"]');

beforeEach(() => {
  _resetProjectPresentationStoreForTest();
  useProjectStore.setState({ currentProject: PROJECT, projects: [PROJECT] });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  _resetProjectPresentationStoreForTest();
});

const reset = () => document.querySelector('[data-testid="project-toolbar-reset"]');
const toolbarSwitch = () => screen.getByRole("switch", { name: "Use this project's toolbar" });

describe("ProjectToolbarProfileNotice", () => {
  it("offers the switch once the project's profile has loaded, even an untouched one", () => {
    render(<ProjectToolbarProfileNotice />);
    expect(notice()).toBeNull();
    applyProfile({});
    expect(toolbarSwitch().getAttribute("aria-checked")).toBe("false");
    expect(notice()?.textContent).toContain(
      "Lets buttons shown or hidden from the toolbar apply to Repo only"
    );
  });

  it("names what the project changes while its toolbar is on", () => {
    render(<ProjectToolbarProfileNotice />);
    applyProfile(
      { copyTree: "demoted", terminal: "demoted" },
      { promotedPluginButtons: [`project__${PROJECT.id}__acme.tools.run`] }
    );
    expect(toolbarSwitch().getAttribute("aria-checked")).toBe("true");
    expect(notice()?.textContent).toContain("Repo moves 2 items into … and shows 1 plugin button");
  });

  it("turns the project's toolbar back on from the switch, keeping its choices", () => {
    const setToolbarEnabled = vi.fn(() => Promise.resolve(true));
    const resetToolbar = vi.fn(() => Promise.resolve(true));
    render(<ProjectToolbarProfileNotice />);
    applyProfile({ copyTree: "demoted" }, { useProjectToolbar: false });
    act(() => {
      useProjectPresentationStore.setState({ setToolbarEnabled, resetToolbar });
    });

    expect(notice()?.textContent).toContain(
      "Repo uses the app-wide toolbar. Its own choices are kept for when this is back on"
    );
    expect(notice()?.textContent).not.toContain("toolbar's menu");
    const before = toolbarSwitch();
    expect(before.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(before);
    expect(setToolbarEnabled).toHaveBeenCalledExactlyOnceWith(true);
    expect(resetToolbar).not.toHaveBeenCalled();

    // The label is the setting, not its state.
    applyProfile({ copyTree: "demoted" }, { useProjectToolbar: true });
    expect(toolbarSwitch().getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toolbarSwitch());
    expect(setToolbarEnabled).toHaveBeenLastCalledWith(false);
  });

  it("says when the switch couldn't be saved and retries it", () => {
    const retryFailedSave = vi.fn();
    render(<ProjectToolbarProfileNotice />);
    applyProfile({}, { useProjectToolbar: false });
    act(() => {
      useProjectPresentationStore.setState({
        failedSave: { kind: "toolbarEnabled", enabled: true },
        retryFailedSave,
      });
    });
    expect(screen.getByRole("alert").textContent).toBe("Couldn't save this project's toolbar");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retryFailedSave).toHaveBeenCalledOnce();
  });
});

describe("ProjectToolbarResetRow", () => {
  it("is offered only while the profile sets something for the toolbar", () => {
    render(<ProjectToolbarResetRow />);
    applyProfile({});
    expect(reset()).toBeNull();
    // A non-toolbar level would not count; forge stats is a toolbar item, so it does.
    applyProfile({ forgeStats: "demoted" });
    expect(reset()).not.toBeNull();
    applyProfile({}, { useProjectToolbar: false });
    expect(reset()).not.toBeNull();
  });

  it("says what it clears and resets only the project's toolbar once confirmed", () => {
    const resetToolbar = vi.fn(() => Promise.resolve(true));
    const resetAppWide = vi.spyOn(useToolbarPreferencesStore.getState(), "reset");
    render(<ProjectToolbarResetRow />);
    applyProfile({ copyTree: "demoted" }, { useProjectToolbar: false });
    act(() => {
      useProjectPresentationStore.setState({ resetToolbar });
    });

    expect(reset()?.textContent).toContain(
      "Clears which items Repo shows or moves into …, the plugin buttons it adds and whether it uses its own toolbar"
    );
    fireEvent.click(screen.getByRole("button", { name: "Reset this project's toolbar" }));
    expect(resetToolbar).not.toHaveBeenCalled();
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain("Reset Repo's toolbar?");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(resetToolbar).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Reset this project's toolbar" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset toolbar" }));
    expect(resetToolbar).toHaveBeenCalledOnce();
    expect(resetAppWide).not.toHaveBeenCalled();
  });
});
