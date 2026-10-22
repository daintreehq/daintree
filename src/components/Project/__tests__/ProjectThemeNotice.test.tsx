// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILT_IN_APP_SCHEMES } from "@/config/appColorSchemes";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAppThemeStore } from "@/store/appThemeStore";
import { resetProjectThemeStoreForTests, useProjectThemeStore } from "@/store/projectThemeStore";
import type { ProjectThemeChoice } from "@shared/theme";
import type { ProjectThemeSnapshot } from "@shared/types/ipc/projectTheme";
import { ProjectThemeNotice } from "../ProjectThemeNotice";

const PROJECT = "a".repeat(64);
const GLOBAL = BUILT_IN_APP_SCHEMES.find((scheme) => scheme.type === "dark")!;
const SUGGESTED = BUILT_IN_APP_SCHEMES.find((scheme) => scheme.type === "light")!;
const QUESTION = `This repository suggests the ${SUGGESTED.name} theme`;

const answerSuggestion =
  vi.fn<(schemeId: string, answer: string) => Promise<ProjectThemeSnapshot>>();

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

function adopt(choice: ProjectThemeChoice | null, suggestedSchemeId: string | null = SUGGESTED.id) {
  act(() => {
    useProjectThemeStore.setState({ loaded: true, projectId: PROJECT, choice, suggestedSchemeId });
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
      <div role="region" aria-label="Panels" tabIndex={-1}>
        <ProjectThemeNotice />
      </div>
    </TooltipProvider>
  );
}

beforeEach(() => {
  resetProjectThemeStoreForTests();
  useAppThemeStore.setState({
    selectedSchemeId: GLOBAL.id,
    customSchemes: [],
    pluginSchemes: [],
    pluginSnapshotScheme: null,
    projectSchemeId: null,
    projectSnapshotScheme: null,
    previewSchemeId: null,
  });
  answerSuggestion.mockReset().mockImplementation(async (schemeId, answer) => ({
    projectId: PROJECT,
    choice: {
      ...(answer === "accepted" ? { colorSchemeId: schemeId } : {}),
      suggestionAnswer: { schemeId, answer: answer as "accepted" | "declined" },
    },
    suggestedSchemeId: schemeId,
  }));
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: {
      projectTheme: {
        // Never settles: the cases seed the store themselves.
        get: vi.fn(() => new Promise(() => {})),
        onChanged: vi.fn(() => () => {}),
        answerSuggestion,
      },
    },
  });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "electron");
  resetProjectThemeStoreForTests();
});

describe("ProjectThemeNotice", () => {
  it("asks only once main has answered for the project", () => {
    renderNotice();
    expect(screen.queryByText(QUESTION)).toBeNull();

    adopt(null);
    expect(screen.getByText(QUESTION)).not.toBeNull();
  });

  it("accepting records the answer and the question goes away", async () => {
    adopt(null);
    renderNotice();

    await act(async () => {
      fireEvent.click(button("Use theme"));
    });

    expect(answerSuggestion).toHaveBeenCalledWith(SUGGESTED.id, "accepted");
    expect(screen.queryByText(QUESTION)).toBeNull();
    expect(useProjectThemeStore.getState().choice?.colorSchemeId).toBe(SUGGESTED.id);
  });

  it("keeping the current theme records a decline", async () => {
    adopt(null);
    renderNotice();

    await act(async () => {
      fireEvent.click(button("Keep current"));
    });

    expect(answerSuggestion).toHaveBeenCalledWith(SUGGESTED.id, "declined");
    expect(screen.queryByText(QUESTION)).toBeNull();
  });

  it("asks nothing once the suggestion has an answer", () => {
    adopt({ suggestionAnswer: { schemeId: SUGGESTED.id, answer: "declined" } });
    renderNotice();
    expect(screen.queryByText(QUESTION)).toBeNull();
  });

  it("asks again when the repository suggests a different theme than the one answered", () => {
    adopt({ suggestionAnswer: { schemeId: "some-other-theme", answer: "declined" } });
    renderNotice();
    expect(screen.getByText(QUESTION)).not.toBeNull();
  });

  it("never asks a project that already has its own theme", () => {
    adopt({ colorSchemeId: GLOBAL.id });
    renderNotice();
    expect(screen.queryByText(QUESTION)).toBeNull();
  });

  it("asks nothing when the suggestion is already the theme on screen", () => {
    useAppThemeStore.setState({ selectedSchemeId: SUGGESTED.id });
    adopt(null);
    renderNotice();
    expect(screen.queryByText(QUESTION)).toBeNull();
  });

  it("asks nothing about a theme this machine can't show", () => {
    adopt(null, "plugin:acme.themes:midnight");
    renderNotice();
    expect(screen.queryByText(/This repository suggests/)).toBeNull();
  });

  it("decide later hides it for this view without recording an answer", () => {
    adopt(null);
    renderNotice();

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Decide later" }));
    });

    expect(screen.queryByText(QUESTION)).toBeNull();
    expect(answerSuggestion).not.toHaveBeenCalled();
  });

  it("keeps a failed answer on screen with a retry", async () => {
    answerSuggestion.mockRejectedValueOnce(new Error("disk full"));
    adopt(null);
    renderNotice();

    await act(async () => {
      fireEvent.click(button("Use theme"));
    });

    expect(screen.getByText("Couldn't save the theme choice")).not.toBeNull();
    await act(async () => {
      fireEvent.click(button("Retry"));
    });
    expect(answerSuggestion).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Couldn't save the theme choice")).toBeNull();
  });
});
