// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@shared/types/project";
import type { ProjectPresentationSnapshot } from "@shared/types/ipc/projectPresentation";
import { resolvePresentation, type PresentationLevels } from "@shared/config/presentationProfile";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useProjectStore } from "@/store/projectStore";
import {
  _resetProjectPresentationStoreForTest,
  useProjectPresentationStore,
} from "@/store/projectPresentationStore";
import {
  ProjectPresentationNotice,
  describeChanges,
  suggestedChanges,
} from "../ProjectPresentationNotice";

const PROJECT = "a".repeat(64);
const HASH = "h1";
const QUESTION = "This repository suggests hiding forge stats";

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

function adopt(overrides: Partial<ProjectPresentationSnapshot> = {}) {
  act(() => {
    useProjectPresentationStore.setState({
      loaded: true,
      projectId: PROJECT,
      levels: {},
      suggestion: { levels: { forgeStats: "hidden" }, hash: HASH },
      suggestionAnswer: null,
      ...overrides,
    });
  });
}

function button(label: string): HTMLElement {
  const match = screen.getAllByRole("button").find((el) => (el.textContent ?? "").trim() === label);
  if (!match) throw new Error(`no button labelled "${label}"`);
  return match;
}

function renderNotice() {
  return render(
    <TooltipProvider>
      {/* The panel grid region the notice sits in, as in the content grids. */}
      <div role="region" aria-label="Panels" tabIndex={-1}>
        <ProjectPresentationNotice />
      </div>
      <button type="button">Elsewhere</button>
    </TooltipProvider>
  );
}

beforeEach(() => {
  _resetProjectPresentationStoreForTest();
  answerSuggestion.mockReset().mockResolvedValue({
    projectId: PROJECT,
    levels: { forgeStats: "hidden" },
    suggestion: { levels: { forgeStats: "hidden" }, hash: HASH },
    suggestionAnswer: { hash: HASH, answer: "accepted", decidedAt: 1 },
    revision: 1,
  });
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: { projectPresentation: { answerSuggestion } },
  });
  setProject();
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "electron");
  _resetProjectPresentationStoreForTest();
  useProjectStore.setState({ currentProject: null });
});

describe("suggestedChanges", () => {
  it("names only the features accepting would actually change", () => {
    const resolve = (levels: PresentationLevels) =>
      resolvePresentation(levels, { gitBacked: true });
    const changes = suggestedChanges(resolve({}), resolve({ forgeStats: "hidden" }));
    expect(changes).toEqual([{ feature: "forgeStats", level: "hidden" }]);
    expect(describeChanges(changes)).toBe("Forge stats hidden");
    expect(
      suggestedChanges(resolve({ forgeStats: "hidden" }), resolve({ forgeStats: "hidden" }))
    ).toEqual([]);
  });

  it("calls quiet git detail by its own name", () => {
    expect(describeChanges([{ feature: "gitDetail", level: "demoted" }])).toBe("Git detail quiet");
  });
});

describe("ProjectPresentationNotice", () => {
  it("asks once the profile is known, naming what would change", () => {
    renderNotice();
    expect(screen.queryByText(QUESTION)).toBeNull();

    adopt();
    expect(screen.getByText(QUESTION)).not.toBeNull();
  });

  it("asks about quieting git detail in the feature's own words", () => {
    adopt({ suggestion: { levels: { gitDetail: "demoted" }, hash: HASH } });
    renderNotice();
    expect(screen.getByText("This repository suggests quieting git detail")).not.toBeNull();
  });

  it("asks nothing when the user already has what the repository suggests", () => {
    adopt({ levels: { forgeStats: "hidden" } });
    renderNotice();
    expect(screen.queryByText(QUESTION)).toBeNull();
  });

  it("records the answer against the suggestion it showed", async () => {
    adopt();
    renderNotice();

    await act(async () => {
      fireEvent.click(button("Apply suggestion"));
    });

    expect(answerSuggestion).toHaveBeenCalledWith(HASH, "accepted");
    expect(screen.queryByText(QUESTION)).toBeNull();
  });

  it("stays down once this suggestion has an answer, either way", () => {
    adopt({ suggestionAnswer: { hash: HASH, answer: "declined", decidedAt: 1 } });
    renderNotice();
    expect(screen.queryByText(QUESTION)).toBeNull();
  });

  it("asks again when the repository suggests something different", () => {
    adopt({ suggestionAnswer: { hash: "older", answer: "declined", decidedAt: 1 } });
    renderNotice();
    expect(screen.getByText(QUESTION)).not.toBeNull();
  });

  it("asks nothing when the suggestion could not take effect", () => {
    // A folder without a repository can't draw forge stats at any level.
    setProject(false);
    adopt({ suggestion: { levels: { forgeStats: "shown" }, hash: HASH } });
    renderNotice();
    expect(screen.queryByText(/This repository suggests/)).toBeNull();
  });

  it("defers for this view without answering", () => {
    adopt();
    renderNotice();

    fireEvent.click(screen.getByRole("button", { name: "Decide later" }));

    expect(screen.queryByText(QUESTION)).toBeNull();
    expect(answerSuggestion).not.toHaveBeenCalled();
  });

  it("offers a retry when the answer could not be saved", async () => {
    answerSuggestion.mockRejectedValueOnce(new Error("disk full"));
    adopt();
    renderNotice();

    await act(async () => {
      fireEvent.click(button("Keep current"));
    });

    expect(screen.getByText("Couldn't save the layout choice")).not.toBeNull();
    await act(async () => {
      fireEvent.click(button("Retry"));
    });
    expect(answerSuggestion).toHaveBeenLastCalledWith(HASH, "declined");
  });

  it("hands focus to the panel region when answering removes the notice from under it", async () => {
    adopt();
    renderNotice();
    const keep = button("Keep current");
    keep.focus();
    fireEvent.keyDown(keep, { key: "Enter" });

    await act(async () => {
      fireEvent.click(keep);
    });

    expect(screen.queryByText(QUESTION)).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("region", { name: "Panels" }));
  });

  it("leaves focus alone once the user has moved it elsewhere", async () => {
    let finish: (value: unknown) => void = () => {};
    answerSuggestion.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    adopt();
    renderNotice();
    const keep = button("Keep current");
    keep.focus();
    fireEvent.click(keep);

    const elsewhere = button("Elsewhere");
    elsewhere.focus();
    await act(async () => {
      finish({
        projectId: PROJECT,
        levels: {},
        suggestion: { levels: { forgeStats: "hidden" }, hash: HASH },
        suggestionAnswer: { hash: HASH, answer: "declined", decidedAt: 1 },
        revision: 1,
      });
    });

    expect(screen.queryByText(QUESTION)).toBeNull();
    expect(document.activeElement).toBe(elsewhere);
  });
});
