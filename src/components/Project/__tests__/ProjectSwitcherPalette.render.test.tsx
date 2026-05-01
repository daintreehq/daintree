/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { render, screen } from "@testing-library/react";

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

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

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

vi.mock("@/store/paletteStore", () => ({
  usePaletteStore: { getState: () => ({ activePaletteId: null }) },
}));

vi.mock("@/store/uiStore", () => ({
  useUIStore: () => 0,
}));

vi.mock("@/components/ui/AppPaletteDialog", () => {
  const Header = ({ children }: { children: React.ReactNode }) => (
    <div data-testid="palette-header">{children}</div>
  );
  const Input = ({
    inputRef,
    ...props
  }: React.InputHTMLAttributes<HTMLInputElement> & {
    inputRef?: React.Ref<HTMLInputElement>;
  }) => <input ref={inputRef} data-testid="palette-input" {...props} />;
  const Body = ({ children }: { children: React.ReactNode }) => (
    <div data-testid="palette-body">{children}</div>
  );
  const Footer = ({ children }: { children: React.ReactNode }) => (
    <div data-testid="palette-footer">{children}</div>
  );

  const Dialog = () => null;
  Dialog.Header = Header;
  Dialog.Input = Input;
  Dialog.Body = Body;
  Dialog.Footer = Footer;

  return { AppPaletteDialog: Dialog };
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

vi.mock("@/components/ui/context-menu", () => ({
  ContextMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuContent: () => null,
  ContextMenuItem: () => null,
  ContextMenuSeparator: () => null,
}));

vi.mock("@/hooks/useModifierKeys", () => ({
  useModifierKeys: () => ({ meta: false, alt: false }),
}));

vi.mock("@/utils/timeAgo", () => ({
  formatTimeAgo: (ts: number) => `${Math.round((Date.now() - ts) / 3600000)}h ago`,
}));

import type { SearchableProject } from "@/hooks/useProjectSwitcherPalette";

const { ProjectSwitcherPalette } = await import("../ProjectSwitcherPalette");

function makeProject(overrides: Partial<SearchableProject> = {}): SearchableProject {
  return {
    id: "proj-1",
    name: "Test Project",
    path: "/tmp/test",
    emoji: "🚀",
    lastOpened: 0,
    frecencyScore: 3.0,
    status: "closed",
    isActive: false,
    isBackground: false,
    isMissing: false,
    isPinned: false,
    processCount: 0,
    activeAgentCount: 0,
    waitingAgentCount: 0,
    displayPath:
      (overrides.path ?? "/tmp/test").replace(/\\/g, "/").split("/").filter(Boolean).pop() ??
      overrides.path ??
      "/tmp/test",
    ...overrides,
  };
}

const modalProps = {
  isOpen: true,
  query: "",
  selectedIndex: 0,
  onQueryChange: vi.fn(),
  onSelectPrevious: vi.fn(),
  onSelectNext: vi.fn(),
  onSelect: vi.fn(),
  onClose: vi.fn(),
  mode: "modal" as const,
};

const dropdownProps = {
  ...modalProps,
  mode: "dropdown" as const,
  onOpenProjectSettings: vi.fn(),
  onAddProject: vi.fn(),
  onCreateFolder: vi.fn(),
  onTogglePinProject: vi.fn(),
  onCloseProject: vi.fn(),
  onStopProject: vi.fn(),
};

const baseProps = dropdownProps;

describe("ProjectSwitcherPalette secondary text waterfall", () => {
  it("shows 'Directory not found' for missing projects", () => {
    render(<ProjectSwitcherPalette {...baseProps} results={[makeProject({ isMissing: true })]} />);
    expect(screen.getByText("Directory not found")).toBeTruthy();
  });

  it("shows 'Agent working…' when activeAgentCount > 0", () => {
    render(
      <ProjectSwitcherPalette
        {...baseProps}
        results={[makeProject({ activeAgentCount: 2, waitingAgentCount: 1 })]}
      />
    );
    expect(screen.getByText("Agent working\u2026")).toBeTruthy();
  });

  it("shows 'Needs review' when only waitingAgentCount > 0", () => {
    render(
      <ProjectSwitcherPalette {...baseProps} results={[makeProject({ waitingAgentCount: 1 })]} />
    );
    expect(screen.getByText("Needs review")).toBeTruthy();
  });

  it("shows relative time when lastOpened > 0 and no agents active", () => {
    const twoHoursAgo = Date.now() - 2 * 3600000;
    render(
      <ProjectSwitcherPalette {...baseProps} results={[makeProject({ lastOpened: twoHoursAgo })]} />
    );
    expect(screen.getByText("2h ago")).toBeTruthy();
  });

  it("falls back to displayPath when lastOpened is 0", () => {
    render(
      <ProjectSwitcherPalette
        {...baseProps}
        results={[makeProject({ path: "/home/user/my-project", displayPath: "my-project" })]}
      />
    );
    expect(screen.getByText("my-project")).toBeTruthy();
  });
});

describe("ProjectSwitcherPalette status dot", () => {
  it("renders idle dot for idle projects", () => {
    render(<ProjectSwitcherPalette {...baseProps} results={[makeProject()]} />);
    expect(screen.getByLabelText("Idle")).toBeTruthy();
  });

  it("renders idle dot for missing projects", () => {
    render(<ProjectSwitcherPalette {...baseProps} results={[makeProject({ isMissing: true })]} />);
    expect(screen.getByLabelText("Idle")).toBeTruthy();
  });

  it("renders active dot for projects with active agents", () => {
    render(
      <ProjectSwitcherPalette {...baseProps} results={[makeProject({ activeAgentCount: 1 })]} />
    );
    expect(screen.getByLabelText("Agents working")).toBeTruthy();
  });

  it("renders waiting dot for projects with waiting agents", () => {
    render(
      <ProjectSwitcherPalette {...baseProps} results={[makeProject({ waitingAgentCount: 1 })]} />
    );
    expect(screen.getByLabelText("Agents waiting")).toBeTruthy();
  });

  it("renders background dot for background projects", () => {
    render(
      <ProjectSwitcherPalette {...baseProps} results={[makeProject({ isBackground: true })]} />
    );
    expect(screen.getByLabelText("Running in background")).toBeTruthy();
  });

  it("renders process dot for projects with running processes", () => {
    render(<ProjectSwitcherPalette {...baseProps} results={[makeProject({ processCount: 1 })]} />);
    expect(screen.getByLabelText("Running in background")).toBeTruthy();
  });
});

describe("ProjectSwitcherPalette secondary text edge cases", () => {
  it("isMissing takes priority over active agents", () => {
    render(
      <ProjectSwitcherPalette
        {...baseProps}
        results={[makeProject({ isMissing: true, activeAgentCount: 2 })]}
      />
    );
    expect(screen.getByText("Directory not found")).toBeTruthy();
    expect(screen.queryByText("Agent working\u2026")).toBeNull();
  });
});

describe("ProjectSwitcherPalette clone repo button", () => {
  it("renders Clone Repository button when onCloneRepo is provided", () => {
    render(
      <ProjectSwitcherPalette {...baseProps} onCloneRepo={vi.fn()} results={[makeProject()]} />
    );
    expect(screen.getByTestId("project-clone-button")).toBeTruthy();
    expect(screen.getByText("Clone Repository...")).toBeTruthy();
  });

  it("calls onCloneRepo when Clone Repository button is clicked", () => {
    const onCloneRepo = vi.fn();
    render(
      <ProjectSwitcherPalette {...baseProps} onCloneRepo={onCloneRepo} results={[makeProject()]} />
    );

    const btn = screen.getByTestId("project-clone-button");
    btn.click();
    expect(onCloneRepo).toHaveBeenCalledOnce();
  });

  it("does not render Clone Repository button when onCloneRepo is not provided", () => {
    render(<ProjectSwitcherPalette {...baseProps} results={[makeProject()]} />);
    expect(screen.queryByTestId("project-clone-button")).toBeNull();
  });
});

describe("ProjectSwitcherPalette modal mode", () => {
  const now = Date.now();
  const multiProjects = [
    makeProject({ id: "active", name: "Active Project", isActive: true, lastOpened: now }),
    makeProject({
      id: "bg",
      name: "Background Project",
      isBackground: true,
      lastOpened: now - 1800000,
    }),
    makeProject({
      id: "pinned",
      name: "Pinned Project",
      isPinned: true,
      lastOpened: now - 3600000,
    }),
    makeProject({ id: "recent", name: "Recent Project", lastOpened: now - 7200000 }),
    makeProject({
      id: "old",
      name: "Old Project",
      lastOpened: now - 14 * 24 * 3600000,
    }),
  ];

  it("shows only active/open projects in modal mode (no closed projects)", () => {
    render(<ProjectSwitcherPalette {...modalProps} results={multiProjects} />);
    expect(screen.getByText("Active Project")).toBeTruthy();
    expect(screen.getByText("Background Project")).toBeTruthy();
    expect(screen.queryByText("Pinned Project")).toBeNull();
    expect(screen.queryByText("Recent Project")).toBeNull();
    expect(screen.queryByText("Old Project")).toBeNull();
  });

  it("renders a flat list with no temporal section labels in modal mode", () => {
    render(<ProjectSwitcherPalette {...modalProps} results={multiProjects} />);
    expect(screen.queryByText("Pinned")).toBeNull();
    expect(screen.queryByText("Today")).toBeNull();
    expect(screen.queryByText("This Week")).toBeNull();
    expect(screen.queryByText("Older")).toBeNull();
  });

  it("shows 'No active projects' when no projects are active/open in modal mode", () => {
    const closedProjects = [
      makeProject({ id: "closed1", name: "Closed 1" }),
      makeProject({ id: "closed2", name: "Closed 2" }),
    ];
    render(<ProjectSwitcherPalette {...modalProps} results={closedProjects} />);
    expect(screen.getByText("No active projects")).toBeTruthy();
  });

  it("does not show management action buttons in modal mode", () => {
    render(<ProjectSwitcherPalette {...modalProps} results={multiProjects} />);
    expect(screen.queryByText("Project Settings...")).toBeNull();
    expect(screen.queryByText("Add Project...")).toBeNull();
    expect(screen.queryByText("Clone Repository...")).toBeNull();
    expect(screen.queryByText("Create New Folder...")).toBeNull();
  });

  it("does not show Remove hint in modal mode footer", () => {
    render(<ProjectSwitcherPalette {...modalProps} results={multiProjects} />);
    const footer = screen.getByTestId("palette-footer");
    expect(footer.textContent).toContain("Switch");
    expect(footer.textContent).not.toContain("Remove");
    expect(footer.textContent).not.toContain("Right-click for more");
  });

  it("shows temporal sections in dropdown mode", () => {
    render(<ProjectSwitcherPalette {...dropdownProps} results={multiProjects} />);
    expect(screen.getByText("Pinned")).toBeTruthy();
  });

  it("shows Remove hint in dropdown mode footer", () => {
    render(<ProjectSwitcherPalette {...dropdownProps} results={multiProjects} />);
    const footer = screen.getByTestId("palette-footer");
    expect(footer.textContent).toContain("Remove");
    expect(footer.textContent).toContain("Right-click for more");
  });

  it("shows all projects in dropdown mode including closed ones", () => {
    render(<ProjectSwitcherPalette {...dropdownProps} results={multiProjects} />);
    expect(screen.getByText("Active Project")).toBeTruthy();
    expect(screen.getByText("Background Project")).toBeTruthy();
    expect(screen.getByText("Pinned Project")).toBeTruthy();
    expect(screen.getByText("Recent Project")).toBeTruthy();
    expect(screen.getByText("Old Project")).toBeTruthy();
  });
});
