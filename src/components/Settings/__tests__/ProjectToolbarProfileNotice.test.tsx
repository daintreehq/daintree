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
import { ProjectToolbarProfileNotice } from "../ProjectToolbarProfileNotice";

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

describe("ProjectToolbarProfileNotice", () => {
  it("says nothing for a project that keeps the app-wide toolbar", () => {
    render(<ProjectToolbarProfileNotice />);
    expect(notice()).toBeNull();
    applyProfile({ forgeStats: "demoted" }, { useProjectToolbar: null });
    // A non-toolbar level would not count; forge stats is a toolbar item, so it does.
    expect(notice()).not.toBeNull();
    applyProfile({});
    expect(notice()).toBeNull();
  });

  it("names what the project changes and resets only the project's toolbar", () => {
    const resetToolbar = vi.fn(() => Promise.resolve(true));
    const resetAppWide = vi.spyOn(useToolbarPreferencesStore.getState(), "reset");
    render(<ProjectToolbarProfileNotice />);
    applyProfile(
      { copyTree: "demoted", terminal: "demoted" },
      { promotedPluginButtons: [`project__${PROJECT.id}__acme.tools.run`] }
    );
    act(() => {
      useProjectPresentationStore.setState({ resetToolbar });
    });

    expect(notice()?.textContent).toContain("Repo moves 2 items into … and shows 1 plugin button");
    fireEvent.click(screen.getByRole("button", { name: "Reset this project's toolbar" }));
    expect(resetToolbar).toHaveBeenCalledOnce();
    expect(resetAppWide).not.toHaveBeenCalled();
  });

  it("says when the project's toolbar is turned off but kept", () => {
    render(<ProjectToolbarProfileNotice />);
    applyProfile({ copyTree: "demoted" }, { useProjectToolbar: false });
    expect(notice()?.textContent).toContain("turned off from the toolbar's menu");
  });
});
