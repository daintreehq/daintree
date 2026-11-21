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
import {
  AssistantPluginMenuItems,
  type AssistantPluginMenuSubject,
} from "../AssistantPluginMenuItems";

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

// The worker row carries no `when`, so only the location keeps it off an assistant.
const CONTRIBUTIONS = [
  item("Worker pane", "terminal"),
  item("Any assistant", "assistant"),
  item("Project lane", "assistant", "assistantScope == 'project'"),
  item("Global run", "assistant", "assistantScope == 'global'"),
  item("Live lane", "assistant", "assistantScope == 'project' && terminalId"),
  item("Claude session", "assistant", "agentId == 'claude'"),
  item("Project one", "assistant", "projectId == 'proj-1'"),
];

function seed(entries = CONTRIBUTIONS) {
  act(() => usePluginContextMenuItemsStore.setState({ entries }));
}

function Menu({ subject }: { subject: AssistantPluginMenuSubject | null }) {
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

type ProjectSubject = Extract<AssistantPluginMenuSubject, { assistantScope: "project" }>;
type GlobalSubject = Extract<AssistantPluginMenuSubject, { assistantScope: "global" }>;

const project = (patch: Partial<ProjectSubject> = {}): ProjectSubject => ({
  assistantScope: "project",
  projectId: "proj-1",
  slot: 2,
  terminalId: "help-term-2",
  agentId: "claude",
  ...patch,
});

const globalRun = (patch: Partial<GlobalSubject> = {}): GlobalSubject => ({
  assistantScope: "global",
  terminalId: "global-term",
  incarnation: 4,
  agentId: "codex",
  ...patch,
});

async function rows() {
  const menu = await screen.findByRole("menu");
  return within(menu)
    .getAllByRole("menuitem")
    .map((row) => row.textContent);
}

const separators = () => within(screen.getByRole("menu")).queryAllByRole("separator").length;

function dispatchedArgs(actionId: string): Record<string, unknown> {
  expect(dispatchMock).toHaveBeenCalledTimes(1);
  const call = dispatchMock.mock.calls[0] as unknown as [string, Record<string, unknown>, unknown];
  expect(call[0]).toBe(actionId);
  expect(call[2]).toEqual({ source: "menu" });
  return call[1];
}

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
      "Claude session",
      "Project one",
    ]);
  });

  it("tells a lane whose terminal isn't up apart from a live one", async () => {
    seed();
    render(<Menu subject={project({ terminalId: undefined })} />);
    expect(await rows()).toEqual([
      "Open docs",
      "Any assistant",
      "Project lane",
      "Claude session",
      "Project one",
    ]);
  });

  it("hides an agent's items from a lane whose agent nothing names", async () => {
    seed();
    render(<Menu subject={project({ agentId: undefined })} />);
    expect(await rows()).toEqual([
      "Open docs",
      "Any assistant",
      "Project lane",
      "Live lane",
      "Project one",
    ]);
  });

  it("matches the lane's own project and agent", async () => {
    seed();
    render(<Menu subject={project({ projectId: "proj-2", agentId: "codex" })} />);
    expect(await rows()).toEqual(["Open docs", "Any assistant", "Project lane", "Live lane"]);
  });

  it("offers the global run its own items and reads its agent, never a project's", async () => {
    seed();
    render(<Menu subject={globalRun({ agentId: "claude" })} />);
    expect(await rows()).toEqual(["Open docs", "Any assistant", "Global run", "Claude session"]);
  });

  it("dispatches a project lane's identity with the menu as the source", async () => {
    seed();
    render(<Menu subject={project()} />);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Project lane" }));
    expect(dispatchedArgs("acme.project-lane")).toStrictEqual({
      assistantScope: "project",
      projectId: "proj-1",
      slot: 2,
      terminalId: "help-term-2",
      agentId: "claude",
    });
  });

  it("leaves out what a lane doesn't have rather than passing it empty", async () => {
    seed();
    render(<Menu subject={project({ slot: 0, terminalId: undefined, agentId: undefined })} />);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Any assistant" }));
    expect(dispatchedArgs("acme.any-assistant")).toStrictEqual({
      assistantScope: "project",
      projectId: "proj-1",
      slot: 0,
    });
  });

  it("dispatches the global run by terminal and incarnation, with no project", async () => {
    seed();
    render(<Menu subject={globalRun({ incarnation: 7 })} />);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Global run" }));
    expect(dispatchedArgs("acme.global-run")).toStrictEqual({
      assistantScope: "global",
      terminalId: "global-term",
      incarnation: 7,
      agentId: "codex",
    });
  });

  it("leaves out the global run's agent while nothing says", async () => {
    seed();
    render(<Menu subject={globalRun({ incarnation: 9, agentId: undefined })} />);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Global run" }));
    expect(dispatchedArgs("acme.global-run")).toStrictEqual({
      assistantScope: "global",
      terminalId: "global-term",
      incarnation: 9,
    });
  });

  it.each([
    ["a new launch of the global run", globalRun(), globalRun({ incarnation: 5 })],
    ["another global terminal", globalRun(), globalRun({ terminalId: "global-term-2" })],
    ["another lane", project({ slot: 1 }), project({ slot: 3 })],
    ["a relaunch in the same lane", project(), project({ terminalId: "help-term-9" })],
    ["the lane's terminal going away", project(), project({ terminalId: undefined })],
    [
      "a terminal binding into a lane that had none",
      project({ terminalId: undefined }),
      project({ terminalId: "help-term-2" }),
    ],
    ["another workspace's lane", project(), project({ projectId: "proj-2" })],
    ["the other assistant", project(), globalRun()],
  ])("drops its rows when the menu's session is replaced by %s", async (_, opened, next) => {
    seed();
    const { rerender } = render(<Menu subject={opened} />);
    expect(await rows()).toContain("Any assistant");
    const before = separators();

    rerender(<Menu subject={next} />);
    expect(await rows()).toEqual(["Open docs"]);
    expect(separators()).toBe(before - 1);
  });

  it("offers nothing for the rest of an opening that started with no session", async () => {
    seed();
    const { rerender } = render(<Menu subject={null} />);
    expect(await rows()).toEqual(["Open docs"]);

    rerender(<Menu subject={globalRun()} />);
    expect(await rows()).toEqual(["Open docs"]);
  });

  it("brings its rows back when the session it opened on returns", async () => {
    seed();
    const { rerender } = render(<Menu subject={globalRun()} />);
    rerender(<Menu subject={null} />);
    expect(await rows()).toEqual(["Open docs"]);

    rerender(<Menu subject={globalRun()} />);
    expect(await rows()).toContain("Global run");
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
    seed([item("Worker pane", "terminal")]);
    render(<Menu subject={project()} />);
    expect(await rows()).toEqual(["Open docs"]);
    expect(separators()).toBe(0);
  });
});
