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
}));

vi.mock("@/hooks", () => ({
  useOverlayState: () => {},
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

const baseProps = {
  isOpen: true,
  query: "",
  selectedIndex: 0,
  onQueryChange: vi.fn(),
  onSelectPrevious: vi.fn(),
  onSelectNext: vi.fn(),
  onSelect: vi.fn(),
  onClose: vi.fn(),
  mode: "modal" as const,
  onOpenProjectSettings: vi.fn(),
  onAddProject: vi.fn(),
  onCreateFolder: vi.fn(),
  onTogglePinProject: vi.fn(),
  onCloseProject: vi.fn(),
  onStopProject: vi.fn(),
};

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
});
