// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@shared/types/project";
import type { PresentationLevel, PresentationLevels } from "@shared/config/presentationProfile";
import type { ProjectPresentationSnapshot } from "@shared/types/ipc/projectPresentation";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useProjectStore } from "@/store/projectStore";
import { _resetProjectPresentationStoreForTest } from "@/store/projectPresentationStore";
import { PresentationFeaturesSection } from "../PresentationFeaturesSection";

const PROJECT = "a".repeat(64);

const snapshot = (levels: PresentationLevels): ProjectPresentationSnapshot => ({
  projectId: PROJECT,
  levels,
  suggestion: null,
  suggestionAnswer: null,
});

const get = vi.fn<() => Promise<ProjectPresentationSnapshot | null>>();
const setLevel = vi.fn<(feature: string, level: PresentationLevel | null) => Promise<unknown>>();
const answerSuggestion = vi.fn<(hash: string, answer: string) => Promise<unknown>>();

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

function setProject(gitBacked = true) {
  const project: Project = {
    id: PROJECT,
    name: "Repo",
    path: "/repo",
    emoji: "",
    lastOpened: 0,
    gitBacked,
  };
  useProjectStore.setState({ currentProject: project });
}

function radio(label: string): HTMLElement {
  const match = screen.getAllByRole("radio").find((el) => (el.textContent ?? "").trim() === label);
  if (!match) throw new Error(`no radio labelled "${label}"`);
  return match;
}

async function renderSection(levels: PresentationLevels = {}) {
  get.mockResolvedValue(snapshot(levels));
  render(
    <TooltipProvider>
      <PresentationFeaturesSection isOpen />
    </TooltipProvider>
  );
  await act(async () => {});
}

beforeEach(() => {
  _resetProjectPresentationStoreForTest();
  get.mockReset();
  setLevel
    .mockReset()
    .mockImplementation((_feature, level) =>
      Promise.resolve(snapshot(level === null ? {} : { forgeStats: level }))
    );
  answerSuggestion.mockReset();
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: {
      projectPresentation: { get, setLevel, answerSuggestion, onChanged: () => () => {} },
    },
  });
  setProject();
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "electron");
  _resetProjectPresentationStoreForTest();
  useProjectStore.setState({ currentProject: null });
});

describe("PresentationFeaturesSection", () => {
  it("shows the level the project resolves to and its git-aware default", async () => {
    await renderSection({ forgeStats: "demoted" });

    expect(radio("Demoted").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText(/Default: Shown/)).not.toBeNull();
    expect(screen.getByRole("button", { name: "Reset Forge stats to default" })).not.toBeNull();
  });

  it("applies a choice at once and clears the entry when it is the default", async () => {
    await renderSection({ forgeStats: "demoted" });

    await act(async () => {
      fireEvent.click(radio("Hidden"));
    });
    expect(setLevel).toHaveBeenLastCalledWith("forgeStats", "hidden");

    await act(async () => {
      fireEvent.click(radio("Shown"));
    });
    // Stored as "follow the default", so the row reads unmodified and a project
    // that later loses its repository follows the new default.
    expect(setLevel).toHaveBeenLastCalledWith("forgeStats", null);
    expect(screen.queryByRole("button", { name: "Reset Forge stats to default" })).toBeNull();
  });

  it("resets a feature to its default", async () => {
    await renderSection({ forgeStats: "hidden" });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Reset Forge stats to default" }));
    });

    expect(setLevel).toHaveBeenLastCalledWith("forgeStats", null);
  });

  it("holds a folder without a repository at hidden and says why", async () => {
    setProject(false);
    await renderSection({ forgeStats: "shown" });

    expect(radio("Hidden").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText(/Default: Hidden/)).not.toBeNull();
    expect(screen.getByText(/Needs a git repository/)).not.toBeNull();
    expect(radio("Shown").hasAttribute("disabled")).toBe(true);
  });

  it("takes no input until main has answered for the project", () => {
    get.mockReturnValue(new Promise(() => {}));
    render(
      <TooltipProvider>
        <PresentationFeaturesSection isOpen />
      </TooltipProvider>
    );

    expect(radio("Shown").getAttribute("aria-checked")).toBe("true");
    expect(radio("Hidden").hasAttribute("disabled")).toBe(true);
  });

  it("offers the repository's suggestion while it would change something", async () => {
    get.mockResolvedValue({
      ...snapshot({}),
      suggestion: { levels: { forgeStats: "hidden" }, hash: "h1" },
      suggestionAnswer: { hash: "h1", answer: "declined", decidedAt: 1 },
    });
    render(
      <TooltipProvider>
        <PresentationFeaturesSection isOpen />
      </TooltipProvider>
    );
    await act(async () => {});

    expect(screen.getByText("Suggested by this repository")).not.toBeNull();
    answerSuggestion.mockResolvedValue({
      ...snapshot({ forgeStats: "hidden" }),
      suggestion: { levels: { forgeStats: "hidden" }, hash: "h1" },
      suggestionAnswer: { hash: "h1", answer: "accepted", decidedAt: 2 },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Apply suggestion" }));
    });

    expect(answerSuggestion).toHaveBeenCalledWith("h1", "accepted");
    expect(screen.queryByText("Suggested by this repository")).toBeNull();
  });

  it("says when a change could not be saved and retries it", async () => {
    await renderSection();
    setLevel.mockRejectedValueOnce(new Error("disk full"));

    await act(async () => {
      fireEvent.click(radio("Demoted"));
    });
    expect(screen.getByText("Couldn't save the change")).not.toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    expect(setLevel).toHaveBeenLastCalledWith("forgeStats", "demoted");
    expect(screen.queryByText("Couldn't save the change")).toBeNull();
  });
});
