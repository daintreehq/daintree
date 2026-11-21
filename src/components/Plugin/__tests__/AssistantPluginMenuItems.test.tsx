// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContextMenuContribution } from "@shared/types/plugin";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  _resetPluginContextMenuItemsStoreForTest,
  usePluginContextMenuItemsStore,
} from "@/store/pluginContextMenuItemsStore";
import { AssistantPluginMenuItems, type AssistantPluginMenuSubject } from "../AssistantPluginMenuItems";

const dispatchMock = vi.hoisted(() => vi.fn(() => Promise.resolve({ ok: true })));
vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: dispatchMock },
}));

function item(
  label: string,
  location: ContextMenuContribution["location"],
  when?: string
): { pluginId: string; item: ContextMenuContribution } {
  const actionId = `acme.${label.toLowerCase().replace(/\W+/g, "-")}`;
  return { pluginId: "acme", item: { actionId, label, location, ...(when && { when }) } };
}

const CONTRIBUTIONS = [
  item("Worker only", "terminal", "panelKind == 'terminal'"),
  item("Any assistant", "assistant"),
  item("Project lane", "assistant", "assistantScope == 'project'"),
  item("Global run", "assistant", "assistantScope == 'global'"),
  item("Live lane", "assistant", "assistantScope == 'project' && terminalId"),
  item("Claude lane", "assistant", "agentId == 'claude'"),
];

function seed(entries = CONTRIBUTIONS) {
  act(() => usePluginContextMenuItemsStore.setState({ entries }));
}

function Menu({ subject }: { subject: AssistantPluginMenuSubject }) {
  return (
    <DropdownMenu open>
      <DropdownMenuTrigger>More</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem>Open docs</DropdownMenuItem>
        <AssistantPluginMenuItems subject={subject} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const project = (patch: Partial<AssistantPluginMenuSubject> = {}): AssistantPluginMenuSubject =>
  ({
    assistantScope: "project",
    projectId: "proj-1",
    slot: 2,
    terminalId: "help-term-2",
    agentId: "claude",
    ...patch,
  }) as AssistantPluginMenuSubject;

const globalRun = (incarnation = 4): AssistantPluginMenuSubject => ({
  assistantScope: "global",
  terminalId: "global-term",
  incarnation,
  agentId: "codex",
});

async function rows() {
  const menu = await screen.findByRole("menu");
  return within(menu)
    .getAllByRole("menuitem")
    .map((row) => row.textContent);
}

const separators = () => within(screen.getByRole("menu")).queryAllByRole("separator").length;

beforeEach(() => {
  _resetPluginContextMenuItemsStoreForTest();
  dispatchMock.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("AssistantPluginMenuItems", () => {
  it("offers a project lane its assistant items and never a worker pane's", async () => {
    seed();
    render(<Menu subject={project()} />);
    expect(await rows()).toEqual([
      "Open docs",
      "Any assistant",
      "Project lane",
      "Live lane",
      "Claude lane",
    ]);
  });

  it("tells a lane with no terminal apart from a live one", async () => {
    seed();
    render(<Menu subject={project({ terminalId: undefined, agentId: undefined })} />);
    expect(await rows()).toEqual(["Open docs", "Any assistant", "Project lane"]);
  });

  it("offers the global run its own items, not a project lane's", async () => {
    seed();
    render(<Menu subject={globalRun()} />);
    expect(await rows()).toEqual(["Open docs", "Any assistant", "Global run"]);
  });

  it("dispatches a project lane's identity with the menu as the source", async () => {
    seed();
    render(<Menu subject={project()} />);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Project lane" }));
    expect(dispatchMock).toHaveBeenCalledWith(
      "acme.project-lane",
      {
        assistantScope: "project",
        projectId: "proj-1",
        slot: 2,
        terminalId: "help-term-2",
        agentId: "claude",
      },
      { source: "menu" }
    );
  });

  it("leaves out what a lane doesn't have rather than passing it empty", async () => {
    seed();
    render(<Menu subject={project({ slot: 0, terminalId: undefined, agentId: undefined })} />);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Any assistant" }));
    const [, args] = dispatchMock.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(Object.keys(args).sort()).toEqual(["assistantScope", "projectId", "slot"]);
    expect(args.slot).toBe(0);
  });

  it("dispatches the global run by terminal and incarnation, with no project", async () => {
    seed();
    render(<Menu subject={globalRun(7)} />);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Global run" }));
    expect(dispatchMock).toHaveBeenCalledWith(
      "acme.global-run",
      { assistantScope: "global", terminalId: "global-term", incarnation: 7, agentId: "codex" },
      { source: "menu" }
    );
  });

  it("drops its rows when the run it opened on is replaced while the menu is open", async () => {
    seed();
    const { rerender } = render(<Menu subject={globalRun(4)} />);
    expect(await rows()).toContain("Global run");
    const before = separators();

    rerender(<Menu subject={globalRun(5)} />);
    expect(await rows()).toEqual(["Open docs"]);
    expect(separators()).toBe(before - 1);
  });

  it("drops its rows when the lane it opened on is swapped for another", async () => {
    seed();
    const { rerender } = render(<Menu subject={project({ slot: 1 })} />);
    expect(await rows()).toContain("Project lane");

    rerender(<Menu subject={project({ slot: 3 })} />);
    expect(await rows()).toEqual(["Open docs"]);
  });

  it("follows a plugin unloading while the menu is open", async () => {
    seed();
    render(<Menu subject={project()} />);
    expect(await rows()).toContain("Any assistant");

    seed([]);
    expect(await rows()).toEqual(["Open docs"]);
    expect(separators()).toBe(0);
  });

  it("adds nothing to the menu when no plugin contributes an assistant item", async () => {
    seed([item("Worker only", "terminal")]);
    render(<Menu subject={project()} />);
    expect(await rows()).toEqual(["Open docs"]);
    expect(separators()).toBe(0);
  });
});
