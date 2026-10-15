/**
 * @vitest-environment jsdom
 *
 * Project groups and archive in the switcher: group band headers, their menus,
 * the empty-group hint, the folded running rollup, and a row's filing actions.
 *
 * Uses the REAL dropdown and context-menu primitives, for the same reason the
 * Other band's sort-control suite does: a stub that rendered items as plain
 * buttons would pass even if a trigger were never wired to its menu.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const originalScrollIntoView = Element.prototype.scrollIntoView;
beforeAll(() => {
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    value: vi.fn(),
    configurable: true,
  });
});
afterAll(() => {
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    value: originalScrollIntoView,
    configurable: true,
  });
});

vi.mock("react-dom", async () => {
  const actual = await vi.importActual<typeof import("react-dom")>("react-dom");
  return { ...actual, createPortal: (children: React.ReactNode) => children };
});

vi.mock("@/lib/colorUtils", () => ({
  getProjectGradient: () => "linear-gradient(red, blue)",
}));

vi.mock("@/hooks/useKeybinding", () => ({
  useKeybindingDisplay: () => "⌘P",
  useEffectiveCombo: () => undefined,
}));

vi.mock("@/hooks", () => ({
  useOverlayState: () => {},
  useOverlayClaim: () => {},
}));
vi.mock("@/hooks/useOverlayState", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useOverlayState")>()),
  useOverlayState: () => {},
}));

vi.mock("@/store/paletteStore", () => ({
  usePaletteStore: { getState: () => ({ activePaletteId: null }) },
}));

vi.mock("@/store/uiStore", () => ({
  useUIStore: () => 0,
}));

vi.mock("@/components/ui/AppPaletteDialog", () => {
  const Header = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  const Input = ({
    inputRef,
    ...props
  }: React.InputHTMLAttributes<HTMLInputElement> & {
    inputRef?: React.Ref<HTMLInputElement>;
  }) => <input ref={inputRef} data-testid="palette-input" {...props} />;
  const Body = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  const Footer = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;

  const Dialog = ({
    isOpen,
    children,
    ariaLabel,
  }: {
    isOpen: boolean;
    children: React.ReactNode;
    ariaLabel: string;
  }) =>
    isOpen ? (
      <div role="dialog" aria-modal="true" aria-label={ariaLabel}>
        {children}
      </div>
    ) : null;
  Dialog.Header = Header;
  Dialog.Input = Input;
  Dialog.Body = Body;
  Dialog.Footer = Footer;
  Dialog.Divider = (props: React.HTMLAttributes<HTMLDivElement>) => <div {...props} />;
  Dialog.Empty = ({
    query,
    emptyMessage,
    noMatchMessage,
    noMatchContent,
  }: {
    query: string;
    emptyMessage?: string;
    noMatchMessage?: string;
    noMatchContent?: React.ReactNode;
  }) =>
    query.trim() ? (
      <div>
        <p>{noMatchMessage}</p>
        {noMatchContent}
      </div>
    ) : (
      <p>{emptyMessage}</p>
    );

  return {
    AppPaletteDialog: Dialog,
    PaletteNoMatchHint: () => <p>Press Esc to clear the search</p>,
    KBD_CLASS: "kbd",
    PALETTE_SURFACE_WIDTHS: {
      // Sentinel values, not the production pixels: this mock only has to satisfy
      // the real AppPalettePopover's width lookup, and copying the shipped
      // classes here would couple every future resize to six mock factories.
      anchored: "mock-anchored-width",
      command: "mock-command-width",
    },
  };
});

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/ui/ConfirmDialog", () => ({
  ConfirmDialog: () => null,
}));

vi.mock("@/hooks/useModifierKeys", () => ({
  useModifierKeys: () => ({ meta: false, alt: false }),
}));

vi.mock("@/utils/timeAgo", () => ({
  formatTimeAgo: () => "1h ago",
}));

import type {
  ProjectSwitcherBrowseBand,
  ProjectSwitcherProjectRow,
  SearchableProject,
} from "@/hooks/useProjectSwitcherPalette";
import { usePreferencesStore } from "@/store/preferencesStore";
import { useProjectGroupsStore } from "@/store/projectGroupsStore";
import { DEFAULT_OTHER_PROJECTS_SORT_MODE } from "@/lib/projectSort";
import { primeRadix } from "@/components/ui/radix-loader";

const { ProjectSwitcherPalette } = await import("../ProjectSwitcherPalette");

beforeAll(async () => {
  // The menu primitives resolve through the lazy Radix loader; without priming
  // the trigger renders as an inert passthrough and never opens.
  await primeRadix();
});

beforeEach(() => {
  usePreferencesStore.getState().setProjectSwitcherOtherSortMode(DEFAULT_OTHER_PROJECTS_SORT_MODE);
  usePreferencesStore.setState({ projectSwitcherCollapsedBands: {} });
});

function makeProject(
  overrides: Partial<SearchableProject> & { id: string }
): ProjectSwitcherProjectRow {
  return {
    kind: "project",
    name: overrides.id,
    path: `/repo/${overrides.id}`,
    emoji: "🌲",
    lastOpened: 1_000,
    status: "closed",
    frecencyScore: 1,
    section: "other",
    isActive: false,
    isBackground: false,
    isMissing: false,
    isPinned: false,
    activeAgentCount: 0,
    waitingAgentCount: 0,
    blockedAgentCount: 0,
    completedAgentCount: 0,
    unacknowledgedCompletedAgentCount: 0,
    snoozedAgentCount: 0,
    processCount: 0,
    displayPath: `/repo/${overrides.id}`,
    ...overrides,
  };
}

const GROUP = {
  id: "crisp",
  name: "Crisp Vector",
  position: 0,
  sortMode: "alphabetical" as const,
  createdAt: 1,
};

function renderGroups({
  groupRows,
  groupCollapsed = false,
  activeAgentCount = 0,
  liftedCount = 0,
}: {
  groupRows: ProjectSwitcherProjectRow[];
  groupCollapsed?: boolean;
  activeAgentCount?: number;
  liftedCount?: number;
}) {
  const other = [makeProject({ id: "loose" })];
  return render(
    <ProjectSwitcherPalette
      isOpen
      mode="modal"
      query=""
      results={[...(groupCollapsed ? [] : groupRows), ...other]}
      browseBands={[
        {
          key: "group:crisp",
          label: GROUP.name,
          itemCount: groupRows.length,
          collapsed: groupCollapsed,
          group: GROUP,
          activeAgentCount,
          liftedCount,
        },
        { key: "other", label: "Other projects", itemCount: 1, collapsed: false },
      ]}
      selectedIndex={0}
      onQueryChange={vi.fn()}
      onSelectPrevious={vi.fn()}
      onSelectNext={vi.fn()}
      onSelect={vi.fn()}
      onClose={vi.fn()}
      onTogglePinProject={vi.fn()}
    />
  );
}

describe("project group bands", () => {
  beforeEach(() => {
    useProjectGroupsStore.setState({ groups: [GROUP], dialog: null });
  });

  it("names a group's band with the group and draws Other projects after it", () => {
    renderGroups({ groupRows: [makeProject({ id: "web", section: "group:crisp" })] });
    const group = document.getElementById("project-section-group-crisp")!;
    const other = document.getElementById("project-section-other")!;
    expect(group.textContent).toBe("Crisp Vector");
    expect(other.textContent).toBe("Other projects");
    // Document order, not just presence: Other projects is the residual band
    // and always renders after every group.
    expect(group.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("says why an open group is empty instead of drawing nothing", () => {
    renderGroups({ groupRows: [] });
    expect(screen.getByTestId("empty-group-hint").textContent).toBe(
      "Right-click a project and choose Move to group"
    );
  });

  it("says how many of an empty group's projects are shown above", () => {
    renderGroups({ groupRows: [], liftedCount: 2 });
    expect(screen.getByTestId("empty-group-hint").textContent).toBe("2 projects shown above");
  });

  it("reports running agents on a folded group's header, and only while folded", () => {
    const { unmount } = renderGroups({
      groupRows: [makeProject({ id: "web", section: "group:crisp", activeAgentCount: 1 })],
      groupCollapsed: true,
      activeAgentCount: 1,
    });
    expect(screen.getByTestId("band-running-rollup-group-crisp").textContent).toContain(
      "1 agent running"
    );
    unmount();
    renderGroups({
      groupRows: [makeProject({ id: "web", section: "group:crisp", activeAgentCount: 1 })],
      activeAgentCount: 1,
    });
    expect(screen.queryByTestId("band-running-rollup-group-crisp")).toBeNull();
  });

  it("offers the group's actions from its header menu", async () => {
    renderGroups({ groupRows: [makeProject({ id: "web", section: "group:crisp" })] });
    fireEvent.pointerDown(screen.getByTestId("band-group-menu-group-crisp"), {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    await waitFor(() => {
      expect(screen.getAllByRole("menuitem").map((el) => el.textContent?.trim())).toEqual([
        "Rename group…",
        "Move up",
        "Move down",
        "Manage groups…",
        "Delete group…",
      ]);
    });
    // A lone group can't move either way.
    const items = screen.getAllByRole("menuitem");
    expect(items[1]!.getAttribute("aria-disabled")).toBe("true");
    expect(items[2]!.getAttribute("aria-disabled")).toBe("true");
  });

  it("opens the rename dialog from the header menu", async () => {
    renderGroups({ groupRows: [makeProject({ id: "web", section: "group:crisp" })] });
    fireEvent.pointerDown(screen.getByTestId("band-group-menu-group-crisp"), {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    const rename = await screen.findByText("Rename group…");
    fireEvent.click(rename);
    expect(useProjectGroupsStore.getState().dialog).toEqual({ kind: "rename", groupId: "crisp" });
  });
});

describe("project row filing menu", () => {
  beforeEach(() => {
    useProjectGroupsStore.setState({ groups: [GROUP], dialog: null });
  });

  it("offers Move to group and Archive project on a project's context menu", async () => {
    renderGroups({
      groupRows: [makeProject({ id: "web", section: "group:crisp", groupId: "crisp" })],
    });
    const row = document.getElementById("project-option-web")!;
    fireEvent.contextMenu(row);
    await screen.findByText("Move to group");
    expect(screen.getByText("Archive project")).toBeTruthy();
  });

  it("offers Unarchive project for an archived row", async () => {
    renderGroups({
      groupRows: [makeProject({ id: "web", section: "group:crisp", isArchived: true })],
    });
    fireEvent.contextMenu(document.getElementById("project-option-web")!);
    await screen.findByText("Unarchive project");
    expect(screen.queryByText("Archive project")).toBeNull();
  });
});

describe("search result filing labels", () => {
  it("names the group and says Archived on a ranked result", () => {
    render(
      <ProjectSwitcherPalette
        isOpen
        mode="modal"
        query="crisp"
        results={[
          makeProject({
            id: "api",
            name: "crisp-vector-backend",
            section: "archived",
            groupId: "crisp",
            groupName: "Crisp Vector",
            isArchived: true,
          }),
        ]}
        rankedSearch
        selectedIndex={0}
        onQueryChange={vi.fn()}
        onSelectPrevious={vi.fn()}
        onSelectNext={vi.fn()}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    );
    const row = document.getElementById("project-option-api")!;
    expect(row.textContent).toContain("· Crisp Vector · Archived");
  });
});

describe("browse filing labels", () => {
  beforeEach(() => {
    useProjectGroupsStore.setState({ groups: [GROUP], dialog: null });
  });

  function renderBands(rows: ProjectSwitcherProjectRow[], bands: ProjectSwitcherBrowseBand[]) {
    return render(
      <ProjectSwitcherPalette
        isOpen
        mode="modal"
        query=""
        results={rows}
        browseBands={bands}
        selectedIndex={0}
        onQueryChange={vi.fn()}
        onSelectPrevious={vi.fn()}
        onSelectNext={vi.fn()}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    );
  }

  it("names the group on a member drawn outside its own group's band", () => {
    renderBands(
      [
        makeProject({ id: "web", section: "running", groupId: "crisp", groupName: "Crisp Vector" }),
        makeProject({
          id: "api",
          section: "group:crisp",
          groupId: "crisp",
          groupName: "Crisp Vector",
        }),
      ],
      [
        { key: "running", label: "Running", itemCount: 1, collapsed: false },
        { key: "group:crisp", label: "Crisp Vector", itemCount: 1, collapsed: false, group: GROUP },
      ]
    );
    expect(document.getElementById("project-option-web")!.textContent).toContain("· Crisp Vector");
    // Under its own group's header, the header already says it.
    expect(document.getElementById("project-option-api")!.textContent).not.toContain(
      "Crisp Vector"
    );
  });

  it("doesn't repeat a group named like the project itself", () => {
    renderBands(
      [
        makeProject({
          id: "app",
          name: "Crisp Vector",
          section: "current",
          isActive: true,
          groupId: "crisp",
          groupName: "Crisp Vector",
        }),
      ],
      [{ key: "current", label: "Current project", itemCount: 1, collapsed: false }]
    );
    expect(document.getElementById("project-option-app")!.textContent).not.toContain("·");
  });

  it("names the group but not Archived again under the Archived header", () => {
    renderBands(
      [
        makeProject({
          id: "old",
          section: "archived",
          isArchived: true,
          groupId: "crisp",
          groupName: "Crisp Vector",
        }),
      ],
      [{ key: "archived", label: "Archived", itemCount: 1, collapsed: false }]
    );
    const text = document.getElementById("project-option-old")!.textContent ?? "";
    expect(text).toContain("· Crisp Vector");
    expect(text).not.toContain("Archived");
  });

  it("reports a working assistant on a folded group, alone and beside agents", () => {
    const folded = (activeAgentCount: number, workingAssistantCount: number) =>
      renderBands(
        [makeProject({ id: "loose" })],
        [
          {
            key: "group:crisp",
            label: "Crisp Vector",
            itemCount: 2,
            collapsed: true,
            group: GROUP,
            activeAgentCount,
            workingAssistantCount,
          },
          { key: "other", label: "Other projects", itemCount: 1, collapsed: false },
        ]
      );
    const rollup = () => screen.getByTestId("band-running-rollup-group-crisp").textContent;

    const alone = folded(0, 1);
    expect(rollup()).toBe("Assistant working");
    alone.unmount();

    const both = folded(2, 1);
    expect(rollup()).toBe("2 agents running · assistant working");
    both.unmount();

    folded(0, 3);
    expect(rollup()).toBe("3 assistants working");
  });
});
