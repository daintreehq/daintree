/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { act, render, screen, fireEvent } from "@testing-library/react";
import { useState } from "react";

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
  const Header = ({ children }: { children: React.ReactNode }) => (
    <div data-testid="palette-header">{children}</div>
  );
  const Input = ({
    inputRef,
    ...props
  }: React.InputHTMLAttributes<HTMLInputElement> & {
    inputRef?: React.Ref<HTMLInputElement>;
  }) => <input ref={inputRef} data-testid="palette-input" {...props} />;
  // Mirrors the real Body's focusable-region contract (role/label/active
  // descendant/handler) so the palette's wiring is observable here. Key
  // filtering itself is covered against the real component in
  // src/components/ui/__tests__/AppPaletteDialog.test.tsx.
  const Body = ({
    children,
    ariaLabel,
    activeDescendant,
    onNavigationKeyDown,
  }: {
    children: React.ReactNode;
    ariaLabel?: string;
    activeDescendant?: string;
    onNavigationKeyDown?: React.KeyboardEventHandler<HTMLDivElement>;
  }) => (
    <div
      data-testid="palette-body"
      tabIndex={0}
      role="group"
      aria-label={ariaLabel}
      aria-activedescendant={activeDescendant}
      onKeyDown={onNavigationKeyDown}
    >
      {children}
    </div>
  );
  const Footer = ({ children }: { children: React.ReactNode }) => (
    <div data-testid="palette-footer">{children}</div>
  );

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
    KBD_CLASS: "px-1.5 py-0.5 rounded-[var(--radius-sm)] bg-border-default text-text-secondary",
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
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
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
  ContextMenuRadioGroup: () => null,
  ContextMenuRadioItem: () => null,
}));

const modifierKeysState = { meta: false, alt: false };
vi.mock("@/hooks/useModifierKeys", () => ({
  useModifierKeys: () => modifierKeysState,
}));

vi.mock("@/utils/timeAgo", () => ({
  formatTimeAgo: () => "2h ago",
}));

const { hostOptions, activateOtherHostOption } = vi.hoisted(() => ({
  hostOptions: {
    value: { groups: [], options: [], remoteNames: new Set<string>() } as unknown,
  },
  activateOtherHostOption: vi.fn(),
}));

vi.mock("@/components/Hosts/OtherHostsSection", async () => {
  const actual = await vi.importActual<typeof import("@/components/Hosts/OtherHostsSection")>(
    "@/components/Hosts/OtherHostsSection"
  );
  return {
    ...actual,
    useOtherHostProjectOptions: () => hostOptions.value,
    useCurrentHostName: () => "This Mac",
    activateOtherHostOption,
  };
});
vi.mock("@/components/Hosts/OpenOnHostSubmenu", () => ({ OpenOnHostSubmenu: () => null }));
vi.mock("@/lib/platform", async () => {
  const actual = await vi.importActual<typeof import("@/lib/platform")>("@/lib/platform");
  return { ...actual, isMac: () => true, isWindows: () => false, isLinux: () => false };
});

import type {
  ProjectSwitcherProjectRow,
  SearchableProject,
} from "@/hooks/useProjectSwitcherPalette";
import {
  otherHostOptionId,
  type OtherHostGroup,
  type OtherHostOption,
} from "@/components/Hosts/OtherHostsSection";

const { ProjectSwitcherPalette } = await import("../ProjectSwitcherPalette");

function makeProject(overrides: Partial<SearchableProject> = {}): ProjectSwitcherProjectRow {
  return {
    kind: "project",
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
    frecencyScore: 3.0,
    processCount: 0,
    activeAgentCount: 0,
    waitingAgentCount: 0,
    blockedAgentCount: 0,
    completedAgentCount: 0,
    unacknowledgedCompletedAgentCount: 0,
    snoozedAgentCount: 0,
    section: "other",
    displayPath:
      (overrides.path ?? "/tmp/test").replace(/\\/g, "/").split("/").filter(Boolean).pop() ??
      overrides.path ??
      "/tmp/test",
    ...overrides,
  };
}

function projectOption(hostId: string, id: string, name: string): OtherHostOption {
  return {
    key: `project:${hostId}:${id}`,
    kind: "project",
    hostId,
    hostName: hostId,
    platform: "linux",
    project: { id, name, path: `/srv/${name}` },
    stale: false,
  };
}

const API = projectOption("studio-01", "s1-api", "api");
const WEB = projectOption("studio-02", "s2-web", "web");
const OPTIONS: OtherHostOption[] = [API, WEB];

/** The band as the hook hands it over: rows grouped by host, and flat. */
function band(options: OtherHostOption[], remoteNames: string[] = []) {
  const groups: OtherHostGroup[] = [];
  for (const option of options) {
    const last = groups[groups.length - 1];
    if (last?.hostId === option.hostId) last.options.push(option);
    else {
      groups.push({
        hostId: option.hostId,
        hostName: option.hostName,
        platform: option.platform,
        link: { tone: "live", state: "Connected" },
        listing: null,
        note: "Connected",
        options: [option],
      });
    }
  }
  return { groups, options, remoteNames: new Set(remoteNames) };
}

const id = (option: OtherHostOption) => otherHostOptionId(option);

const RESULTS = [
  makeProject({ id: "p1", name: "Project 1" }),
  makeProject({ id: "p2", name: "Project 2" }),
];

const onSelect = vi.fn();
const onClose = vi.fn();
const onCloseProject = vi.fn();

// Steps the selection the way useProjectSwitcherPalette does: relative, wrapping,
// resolved inside the updater so batched steps compose.
function Harness({
  results = RESULTS,
  query = "",
}: {
  results?: ProjectSwitcherProjectRow[];
  query?: string;
}) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const step = (delta: number) =>
    setSelectedIndex((from) =>
      results.length === 0 ? 0 : (from + delta + results.length) % results.length
    );
  return (
    <ProjectSwitcherPalette
      isOpen
      mode="modal"
      query={query}
      results={results}
      selectedIndex={selectedIndex}
      onQueryChange={vi.fn()}
      onSelectPrevious={() => step(-1)}
      onSelectNext={() => step(1)}
      onSelect={onSelect}
      onClose={onClose}
      onCloseProject={onCloseProject}
    />
  );
}

function press(key: string, init: Record<string, unknown> = {}) {
  act(() => {
    fireEvent.keyDown(screen.getByTestId("palette-input"), { key, ...init });
  });
}

function active(): string | null {
  return screen.getByTestId("palette-input").getAttribute("aria-activedescendant");
}

function selectedOptions(): string[] {
  return [...document.querySelectorAll('[role="option"][aria-selected="true"]')].map((el) => el.id);
}

describe("ProjectSwitcherPalette other-host rows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hostOptions.value = band(OPTIONS);
  });

  afterEach(() => {
    hostOptions.value = band([]);
  });

  it("walks from the last result into other hosts' projects and wraps back to the first", () => {
    render(<Harness />);
    expect(active()).toBe("project-option-p1");
    press("ArrowDown");
    expect(active()).toBe("project-option-p2");
    press("ArrowDown");
    expect(active()).toBe(id(API));
    // Exactly one row reads as selected: the local result gives up the highlight.
    expect(selectedOptions()).toEqual([id(API)]);
    expect(document.getElementById(active()!)?.getAttribute("aria-label")).toBe(
      "api on studio-01, /srv/api"
    );
    press("ArrowDown");
    expect(active()).toBe(id(WEB));
    press("ArrowDown");
    expect(active()).toBe("project-option-p1");
  });

  it("wraps upward from the first result into the last other-host row and back", () => {
    render(<Harness />);
    press("ArrowUp");
    expect(active()).toBe(id(WEB));
    press("ArrowUp");
    expect(active()).toBe(id(API));
    press("ArrowUp");
    expect(active()).toBe("project-option-p2");
  });

  it("names the other-host listbox in aria-controls so the active descendant resolves", () => {
    render(<Harness />);
    const controls = screen.getByTestId("palette-input").getAttribute("aria-controls")!;
    expect(controls.split(" ")).toContain("project-switcher-other-hosts-list");
    press("ArrowUp");
    const option = document.getElementById(active()!)!;
    expect(option.getAttribute("role")).toBe("option");
    expect(option.closest("#project-switcher-other-hosts-list")).not.toBeNull();
    // Roving selection, like every other result: no tab stop of its own.
    expect(option.tabIndex).toBe(-1);
  });

  it("opens the active other-host project on Enter, in a new window on Cmd+Enter", () => {
    render(<Harness />);
    press("ArrowUp");
    press("Enter");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(activateOtherHostOption).toHaveBeenCalledWith(WEB, false);
    expect(onSelect).not.toHaveBeenCalled();

    press("Enter", { metaKey: true });
    expect(activateOtherHostOption).toHaveBeenLastCalledWith(WEB, true);
  });

  it("keeps the cursor on its project when another host's rows arrive above it", () => {
    const { rerender } = render(<Harness />);
    press("ArrowUp");
    expect(active()).toBe(id(WEB));

    // A host connects mid-search and its rows land ahead of the highlighted one.
    const early = projectOption("studio-00", "s0-app", "app");
    hostOptions.value = band([early, API, WEB]);
    rerender(<Harness />);
    expect(active()).toBe(id(WEB));
    expect(selectedOptions()).toEqual([id(WEB)]);
    press("Enter");
    expect(activateOtherHostOption).toHaveBeenCalledWith(WEB, false);
  });

  it("gives the cursor back to the results when its row goes away, rather than its neighbour", () => {
    const { rerender } = render(<Harness />);
    press("ArrowUp");
    expect(active()).toBe(id(WEB));

    hostOptions.value = band([API]);
    rerender(<Harness />);
    expect(active()).toBe("project-option-p1");
    press("Enter");
    expect(activateOtherHostOption).not.toHaveBeenCalled();
    expect(onSelect).toHaveBeenCalled();
  });

  it("tells the same project id on two hosts apart", () => {
    const twin = {
      ...WEB,
      key: "project:studio-03:s2-web",
      hostId: "studio-03",
      hostName: "studio-03",
    };
    hostOptions.value = band([API, WEB, twin]);
    render(<Harness />);
    press("ArrowUp");
    expect(active()).toBe(id(twin));
    press("Enter");
    expect(activateOtherHostOption).toHaveBeenCalledWith(twin, false);
  });

  it("reaches the band's ends with Home, End and the page keys", () => {
    render(<Harness />);
    press("End");
    expect(active()).toBe(id(WEB));
    press("Home");
    expect(active()).toBe("project-option-p1");
    press("PageDown");
    expect(active()).toBe(id(WEB));
  });

  it("says in the footer what Enter does on an other-host row", () => {
    render(<Harness />);
    press("ArrowUp");
    expect(screen.getByTestId("palette-footer").textContent).toContain("Open on studio-02");
  });

  it("keeps the palette open for Retry", () => {
    const retry: OtherHostOption = {
      key: "retry:studio-02:",
      kind: "retry",
      hostId: "studio-02",
      hostName: "studio-02",
      platform: "linux",
    };
    hostOptions.value = band([API, retry]);
    render(<Harness />);
    press("ArrowUp");
    expect(screen.getByTestId("palette-footer").textContent).toContain("Retry");
    press("Enter");
    expect(activateOtherHostOption).toHaveBeenCalledWith(retry, false);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("never closes a local project with Cmd+Backspace from an other-host row", () => {
    render(<Harness />);
    press("ArrowUp");
    press("Backspace", { metaKey: true });
    expect(onCloseProject).not.toHaveBeenCalled();
  });

  it("highlights another host's first project when nothing local matches, so Enter opens it", () => {
    render(<Harness results={[]} />);
    expect(active()).toBe(id(API));
    press("Enter");
    expect(activateOtherHostOption).toHaveBeenCalledWith(API, false);
    press("ArrowDown");
    expect(active()).toBe(id(WEB));
    press("ArrowDown");
    expect(active()).toBe(id(API));
  });

  it("keeps the automatically highlighted row when another host's rows arrive above it", () => {
    hostOptions.value = band([WEB]);
    const { rerender } = render(<Harness results={[]} />);
    expect(active()).toBe(id(WEB));

    hostOptions.value = band([API, WEB]);
    rerender(<Harness results={[]} />);
    expect(active()).toBe(id(WEB));
    press("Enter");
    expect(activateOtherHostOption).toHaveBeenCalledWith(WEB, false);
  });

  it("hands the automatic highlight back once local results arrive for the same query", () => {
    const { rerender } = render(<Harness results={[]} />);
    expect(active()).toBe(id(API));
    rerender(<Harness results={RESULTS} />);
    expect(active()).toBe("project-option-p1");
  });

  it("forgets a band pick made under an earlier query once the query is cleared", () => {
    const { rerender } = render(<Harness />);
    press("ArrowUp");
    expect(active()).toBe(id(WEB));
    hostOptions.value = band([]);
    rerender(<Harness query="project" />);
    hostOptions.value = band(OPTIONS);
    rerender(<Harness />);
    expect(active()).toBe("project-option-p1");
  });

  it("keeps an automatic pick the pointer moved onto once local results arrive", () => {
    const { rerender } = render(<Harness results={[]} />);
    expect(active()).toBe(id(API));
    fireEvent.pointerMove(document.getElementById(id(API))!);
    rerender(<Harness results={RESULTS} />);
    expect(active()).toBe(id(API));
  });

  it("names this host beside a local project another host also has", () => {
    hostOptions.value = band(OPTIONS, ["project 1"]);
    render(<Harness />);
    expect(document.getElementById("project-option-p1")?.textContent).toContain("This Mac");
    expect(document.getElementById("project-option-p2")?.textContent).not.toContain("This Mac");
  });

  it("changes nothing for someone with no remote host", () => {
    hostOptions.value = band([]);
    render(<Harness />);
    expect(screen.getByTestId("palette-input").getAttribute("aria-controls")).toBe("project-list");
    press("ArrowDown");
    press("ArrowDown");
    expect(active()).toBe("project-option-p1");
    expect(screen.queryByTestId("project-switcher-other-hosts")).toBeNull();
  });
});
