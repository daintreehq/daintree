// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { ReactNode } from "react";

const dispatchMock = vi.hoisted(() => vi.fn<(actionId: string, args: unknown) => void>());

vi.mock("@/components/ui/context-menu", () => ({
  ContextMenuActionItem: ({
    actionId,
    args,
    children,
  }: {
    actionId: string;
    args?: unknown;
    children: ReactNode;
  }) => (
    <button data-entry="item" onClick={() => dispatchMock(actionId, args)}>
      {children}
    </button>
  ),
  ContextMenuSeparator: () => <hr data-entry="separator" />,
}));

vi.mock("../ToolbarContextMenuItems", () => ({
  ToolbarContextMenuItems: ({ buttonId, side }: { buttonId: string; side: string }) => (
    <div data-entry={`chrome:${buttonId}:${side}`} />
  ),
}));

import { ForgeStatsContextMenuItems } from "../ForgeStatsContextMenuItems";

afterEach(() => {
  cleanup();
  dispatchMock.mockReset();
});

// The menu as a reader meets it, top to bottom: item labels, separators, and
// the shared toolbar chrome block.
function menuEntries(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("[data-entry]"), (el) => {
    const entry = el.getAttribute("data-entry") ?? "";
    return entry === "item" ? (el.textContent ?? "") : entry;
  });
}

describe("ForgeStatsContextMenuItems", () => {
  it("leads a segment's menu with its own list, then the repository, then toolbar chrome", () => {
    const { container } = render(
      <ForgeStatsContextMenuItems
        segment="issues"
        projectPath="/repo"
        providerName="GitHub"
        canOpenRepo
      />
    );

    expect(menuEntries(container)).toEqual([
      "View all issues on GitHub",
      "separator",
      "View repository on GitHub",
      "separator",
      "chrome:forge-stats:right",
    ]);
  });

  it.each([
    { segment: "issues", label: "View all issues on GitLab", actionId: "forge.openIssues" },
    { segment: "prs", label: "View all pull requests on GitLab", actionId: "forge.openPRs" },
    { segment: "commits", label: "View commits on GitLab", actionId: "forge.openCommits" },
  ] as const)(
    "$segment opens its own list on the resolved provider",
    ({ segment, label, actionId }) => {
      const { getByText } = render(
        <ForgeStatsContextMenuItems
          segment={segment}
          projectPath="/repo"
          providerName="GitLab"
          canOpenRepo={false}
        />
      );

      fireEvent.click(getByText(label));

      expect(dispatchMock).toHaveBeenCalledWith(actionId, { projectPath: "/repo" });
    }
  );

  it("opens the branch the commits pill lists, so the forge shows the same history", () => {
    const { getByText } = render(
      <ForgeStatsContextMenuItems
        segment="commits"
        projectPath="/repo"
        providerName="GitHub"
        branch="feature/x"
        canOpenRepo={false}
      />
    );

    fireEvent.click(getByText("View commits on GitHub"));

    expect(dispatchMock).toHaveBeenCalledWith("forge.openCommits", {
      projectPath: "/repo",
      branch: "feature/x",
    });
  });

  it("keeps the branch off every segment but commits", () => {
    const { getByText } = render(
      <ForgeStatsContextMenuItems
        segment="prs"
        projectPath="/repo"
        providerName="GitHub"
        branch="feature/x"
        canOpenRepo={false}
      />
    );

    fireEvent.click(getByText("View all pull requests on GitHub"));

    expect(dispatchMock).toHaveBeenCalledWith("forge.openPRs", { projectPath: "/repo" });
  });

  it("opens the repository through forge.openRepo", () => {
    const { getByText } = render(
      <ForgeStatsContextMenuItems
        segment="issues"
        projectPath="/repo"
        providerName="GitHub"
        canOpenRepo
      />
    );

    fireEvent.click(getByText("View repository on GitHub"));

    expect(dispatchMock).toHaveBeenCalledWith("forge.openRepo", { projectPath: "/repo" });
  });

  it("drops the repository entry and its separator when the provider can't link to one", () => {
    const { container } = render(
      <ForgeStatsContextMenuItems
        segment="prs"
        projectPath="/repo"
        providerName="GitHub"
        canOpenRepo={false}
      />
    );

    expect(menuEntries(container)).toEqual([
      "View all pull requests on GitHub",
      "separator",
      "chrome:forge-stats:right",
    ]);
  });

  it("gives the container around the pills the repository and chrome, with no segment entry", () => {
    const { container } = render(
      <ForgeStatsContextMenuItems projectPath="/repo" providerName="GitHub" canOpenRepo />
    );

    expect(menuEntries(container)).toEqual([
      "View repository on GitHub",
      "separator",
      "chrome:forge-stats:right",
    ]);
  });

  it("keeps only toolbar chrome when the project has no forge provider", () => {
    const { container } = render(
      <ForgeStatsContextMenuItems
        segment="commits"
        projectPath="/repo"
        providerName={null}
        branch="main"
        canOpenRepo
      />
    );

    expect(menuEntries(container)).toEqual(["chrome:forge-stats:right"]);
  });
});
