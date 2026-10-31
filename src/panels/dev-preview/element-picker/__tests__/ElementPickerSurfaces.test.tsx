// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ProjectContextOutcome,
  ResolutionResult,
  SelectionObservation,
} from "@shared/elementPicker";
import type { ElementPickerWorkspaceOpenResult } from "@shared/types/ipc/elementPicker";

const context = vi.hoisted(() => ({
  current: { projectId: "p1", worktreeId: "wt-1", worktreePath: "/repo" },
}));

import { ElementPickerDrawer, ElementPickerToolbar } from "../ElementPickerSurfaces";
import { HMR_SETTLE_MS, type InspectorController } from "../inspectorController";
import { ELEMENT_PICKER_TOOL_ID } from "../toolId";
import { citedRevisions, type PickedSelection } from "../selection";
import {
  __resetDevPreviewToolSessionsForTests,
  peekDevPreviewToolSession,
  publishDevPreviewToolContext,
  startDevPreviewToolSessions,
  useDevPreviewToolSessionHandle,
} from "@/services/devPreviewTools/sessionManager";
import { _resetPluginRuntimeStoreForTest, usePluginRuntimeStore } from "@/store/pluginRuntimeStore";
import { useDevPreviewToolStore } from "@/store/devPreviewToolStore";
import {
  __resetComposerMemoryForTests,
  composerMemoryKey,
  readComposerMemory,
  setDrawerCollapsed,
  updateComposerMemory,
} from "../composerMemory";
import { usePanelStore } from "@/store/panelStore";
// The picker renders inside the app's TooltipProvider (App.tsx); its segmented
// controls carry Radix tooltips, so the harness supplies the same ancestor.
import { TooltipProvider } from "@/components/ui/tooltip";
import { UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils";
import { __resetAgentRequestsForTests } from "@/services/agentRequests";
import {
  CARD,
  CARD_CALL,
  CARD_FILE,
  CARD_REVISION,
  FILE,
  REVISION,
  SHELL,
  STAMP,
  WORKSPACE,
  reactObservation,
  sha,
  svelteObservation,
  svelteRecord,
  svelteResults,
} from "./fixtures";
import { createFakeHost, verifyAll, workspaceClosedError, type FakeHost } from "./testHost";

let host: FakeHost;
let uninstall: () => void;

function hostContext() {
  return {
    panelId: "preview-1",
    ...context.current,
    url: "http://localhost:5173/pricing",
    isWebviewReady: true,
  };
}

/** The picker's session, which the host owns for as long as the tool is on. */
function session(): InspectorController {
  const live = peekDevPreviewToolSession("preview-1");
  if (!live) throw new Error("no picker session for preview-1");
  return live as InspectorController;
}

/**
 * Switch the picker on the way the dev preview does — through the real host
 * session manager, which resolves the built-in tool itself: no plugin is
 * registered, enabled or consulted.
 */
function switchOn() {
  startDevPreviewToolSessions();
  publishDevPreviewToolContext(hostContext());
  useDevPreviewToolStore.getState().setActive("preview-1", ELEMENT_PICKER_TOOL_ID);
}

function switchOff() {
  return act(async () => useDevPreviewToolStore.getState().setActive("preview-1", null));
}

/**
 * What the dev preview mounts while the Element Picker is switched on: its
 * surfaces, once the host has the session they read.
 */
function PickerHarness() {
  const handle = useDevPreviewToolSessionHandle("preview-1", ELEMENT_PICKER_TOOL_ID);
  const live = (handle?.session ?? null) as InspectorController | null;
  if (live === null) return null;
  const props = { ...hostContext(), session: live, onClose: () => {} };
  return (
    <>
      <ElementPickerToolbar {...props} />
      <ElementPickerDrawer {...props} />
    </>
  );
}

function mount() {
  switchOn();
  return render(<PickerHarness />, { wrapper: TooltipProvider });
}

async function mountBound() {
  mount();
  await waitFor(() => expect(host.picker.bind).toHaveBeenCalled());
  await screen.findByRole("radio", { name: "Browse" });
  await act(async () => host.documentReady(0));
}

async function mountSelected() {
  await mountBound();
  await act(async () => host.select(0));
  // The selection has landed when the drawer names where it came from and the
  // composer is there to send a request about it.
  await screen.findByRole("textbox", { name: "Request for the agent" });
  await waitFor(() =>
    expect(screen.getByRole("region", { name: "Selected element" }).textContent).toContain(
      `${FILE}:6`
    )
  );
}

function text(): string {
  return document.body.textContent ?? "";
}

/** Send, by the destination it names: "Send to {session}" or "Start a new {agent} session and send". */
const SEND_NAME = /^(Send to |Start a new .+ session and send$)/;

/** The note under Send, which Send names as its description. */
function sendNote(): string {
  const send = screen.getByRole("button", { name: SEND_NAME });
  return document.getElementById(send.getAttribute("aria-describedby") ?? "")?.textContent ?? "";
}

/** The identity block and the note under Send word a stale selection the same way. */
function expectStaleAgrees(headline: string): void {
  const identity = screen.getByRole("region", { name: "Selected element" });
  expect(within(identity).getByText(headline)).toBeTruthy();
  expect(sendNote()).toBe(headline);
}

/** Send is off through `aria-disabled`, so it stays focusable to say why. */
function isOff(button: HTMLElement): boolean {
  return button.getAttribute("aria-disabled") === "true";
}

/**
 * The buttons in a surface that act. Every crumb is a button so its name and
 * file are a focus away; the ones that can't be picked say so with
 * `aria-disabled`, and those are not offers.
 */
function enabledButtons(surface: HTMLElement, name?: string): HTMLElement[] {
  return within(surface)
    .queryAllByRole("button", name === undefined ? {} : { name })
    .filter((button) => button.getAttribute("aria-disabled") !== "true");
}

/** Let real time pass, flushing what it settles. */
function pause(ms: number) {
  return act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));
}

/**
 * Long enough for a retry, a reattach or a delivery poll to have run if one
 * was going to; the picker's own waits are all shorter.
 */
const QUIET_WINDOW_MS = 1_200;
/** Past a release deferred to a timer, short of anything the picker schedules. */
const ONE_TICK_MS = 5;
/** Past the delay before the picker reattaches to a preview whose page was recreated. */
const PAST_REATTACH_MS = 500;

/** Drive fake timers, flushing what each step settles. */
async function elapse(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** A described SvelteKit app, as the host reads one from disk. */
function sveltekitProject(
  overrides: {
    route?: { routeId: string; files: Array<{ role: "page" | "layout" | "data"; path: string }> };
    verdict?: "tested" | "untested";
    reasons?: string[];
    versions?: {
      svelte: string | null;
      kit: string | null;
      tailwind: string | null;
      vite: string | null;
    };
  } = {}
): ProjectContextOutcome {
  return {
    status: "described",
    context: {
      adapter: "sveltekit",
      appPath: ".",
      route: overrides.route
        ? {
            routeId: overrides.route.routeId,
            files: overrides.route.files.map((entry) => ({
              role: entry.role,
              file: { workspaceId: WORKSPACE, path: entry.path },
            })),
          }
        : null,
      routes: { directory: "src/routes", source: "default", basePath: "", complete: true },
      toolchain: {
        versions: overrides.versions ?? {
          svelte: "5.2.0",
          kit: "2.15.0",
          tailwind: "4.1.0",
          vite: "7.0.0",
        },
        verdict: overrides.verdict ?? "tested",
        reasons: overrides.reasons ?? [],
        missingInstall: [],
      },
      diagnostics: [],
    },
  };
}

/** An element with nothing a framework could trace: what the page shows of it is all there is. */
const PAGE_NODE: SelectionObservation = svelteObservation({
  elementId: "el-page",
  tagName: "BUTTON",
  label: "button.cta",
  bounds: [{ x: 40, y: 80, width: 120, height: 40 }],
  componentChain: { nearestId: null, components: [], truncated: false },
  sourceCandidates: [],
  frameworkEvidence: [],
  capabilities: {
    names: { state: "unavailable", reason: "no-framework" },
    chain: { state: "unavailable", reason: "no-framework" },
    componentSelection: { state: "unavailable", reason: "no-framework" },
    file: { state: "unavailable", reason: "no-framework" },
    line: { state: "unavailable", reason: "no-framework" },
    exactRange: { state: "unavailable", reason: "no-framework" },
  },
  context: {
    selector: "main > button.cta",
    markup: '<button class="cta" type="button">Start Pro</button>',
    styles: [
      { property: "display", value: "inline-flex" },
      { property: "padding", value: "8px 16px" },
    ],
  },
});

beforeEach(() => {
  context.current = { projectId: "p1", worktreeId: "wt-1", worktreePath: "/repo" };
  // The host only keeps a tool switched on for a preview the panel store
  // holds; tests that need more of the panel replace this wholesale.
  usePanelStore.setState({
    panelIds: ["preview-1"],
    panelsById: { "preview-1": { id: "preview-1", kind: "dev-preview", location: "grid" } },
  } as never);
  host = createFakeHost();
  uninstall = host.install();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  _resetPluginRuntimeStoreForTest();
  useDevPreviewToolStore.setState({ activeByPanel: {} });
  // Both halves: a test that seeds terminals sets `panelIds` too, and leaving
  // those ids behind hands the next test a composer with phantom destinations.
  usePanelStore.setState({ panelIds: [], panelsById: {} } as never);
  cleanup();
  __resetDevPreviewToolSessionsForTests();
  __resetComposerMemoryForTests();
  // Delivery remembers each terminal it typed into; several tests really send.
  __resetAgentRequestsForTests();
  uninstall();
});

describe("page verdicts", () => {
  it("drops a production-build verdict that a traced selection disproves", async () => {
    await mountBound();
    await act(async () => host.runtimeIssue("not-dev-build"));
    expect(text()).toContain("Production build");

    await act(async () => host.select(0));
    await screen.findByRole("textbox", { name: "Request for the agent" });
    expect(text()).not.toContain("Production build");
  });

  it("drops a production-build verdict once the pointer finds a traced element", async () => {
    await mountBound();
    await act(async () => host.runtimeIssue("not-dev-build"));
    expect(text()).toContain("Production build");
    // The page hydrated after its audit; nothing was clicked, only hovered.
    await act(async () => host.hover(svelteObservation()));
    expect(text()).not.toContain("Production build");
  });

  it("keeps a framework's verdict that another framework's element says nothing about", async () => {
    await mountBound();
    await act(async () => host.runtimeIssue("metadata-unavailable", { framework: "react" }));
    expect(text()).toContain("No React source locations");

    // A traced Svelte element is no proof of React's metadata…
    await act(async () => host.select(0));
    await screen.findByRole("textbox", { name: "Request for the agent" });
    expect(text()).toContain("No React source locations");

    // …and a traced React one is.
    host.template = () => reactObservation();
    await act(async () => host.select(0));
    await waitFor(() => expect(text()).not.toContain("No React source locations"));
  });

  it("never promises what a request carries, which the composer's Includes row says", async () => {
    await mountBound();
    await act(async () => host.runtimeIssue("not-dev-build"));
    expect(text()).toContain("dev server");
    expect(text()).not.toMatch(/screenshot|request still carries/i);

    await act(async () => host.runtimeIssue("metadata-unavailable", { framework: "react" }));
    expect(text()).toContain("No React source locations");
    expect(text()).not.toMatch(/screenshot|request still carries/i);

    await act(async () =>
      host.runtimeIssue("extractor-failed", { framework: "svelte", detail: "no __svelte_meta" })
    );
    expect(text()).toContain("Couldn't read this page's Svelte components");
    expect(text()).not.toMatch(/screenshot|request still carries/i);
  });

  it("warns up front when the page's components can't be read", async () => {
    await mountBound();
    await act(async () =>
      host.runtimeIssue("extractor-failed", { framework: "svelte", detail: "no __svelte_meta" })
    );
    expect(text()).toContain("Couldn't read this page's Svelte components");
    // The page's own words survive under the headline.
    expect(text()).toContain("no __svelte_meta");
  });

  it("keeps a verdict that a traced element says nothing about", async () => {
    await mountBound();
    await act(async () => host.runtimeIssue("overlay-blocked"));
    await act(async () => host.select(0));
    await screen.findByRole("textbox", { name: "Request for the agent" });
    expect(text()).toContain("The page blocked the selection outline");
  });

  it("raises the page's own verdict whichever app the worktree holds", async () => {
    // The page's verdict is about the page the preview shows, so it stands
    // even while the user has yet to say which app that is.
    host.openWith = () => ({
      status: "ambiguous",
      appPaths: ["apps/docs", "apps/admin"],
      scanComplete: true,
    });
    await mountBound();
    await waitFor(() => expect(session().getSnapshot().workspace.status).toBe("ambiguous"));
    await act(async () => host.runtimeIssue("not-dev-build"));
    expect(session().getSnapshot().issue?.code).toBe("not-dev-build");
  });

  it("takes a fault the host observed the same way as one the page reported, for the current document only", async () => {
    await mountBound();
    await act(async () => host.documentReady(1));
    await act(async () =>
      host.pushPreview({
        kind: "host-issue",
        sessionId: "session-1",
        projectId: "p1",
        documentEpoch: 0,
        issue: { type: "runtimeIssue", code: "internal", detail: "an older document" },
      })
    );
    expect(session().getSnapshot().issue).toBeNull();
    await act(async () =>
      host.pushPreview({
        kind: "host-issue",
        sessionId: "session-1",
        projectId: "p1",
        documentEpoch: 1,
        issue: { type: "runtimeIssue", code: "internal", detail: "" },
      })
    );
    expect(screen.getByRole("alert").textContent).toContain("inside the page");
  });
});

describe("preview binding", () => {
  it("binds its own preview in Inspect mode, naming no runtime of its own", async () => {
    mount();
    await waitFor(() => expect(host.picker.bind).toHaveBeenCalledTimes(1));
    // The panel and the mode, never a body or an adapter: the host owns the
    // runtime it installs.
    expect(host.picker.bind.mock.calls[0]![0]).toEqual({ panelId: "preview-1", mode: "select" });
    await screen.findByRole("radio", { name: "Browse" });
  });

  it("switches the preview between Browse and Select", async () => {
    await mountBound();
    fireEvent.click(screen.getByRole("radio", { name: "Browse" }));
    await waitFor(() =>
      expect(host.preview.setMode).toHaveBeenCalledWith({ sessionId: "session-1", mode: "browse" })
    );
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: "Browse" }).getAttribute("aria-checked")).toBe(
        "true"
      )
    );
  });

  it("offers the app choice when the worktree holds more than one app", async () => {
    const apps = ["apps/web", "apps/docs"];
    host.openWith = (request) =>
      request.appPath
        ? {
            status: "ready",
            workspaceId: "ws-1",
            appPath: request.appPath,
            appPaths: apps,
            scanComplete: true,
          }
        : { status: "ambiguous", appPaths: apps, scanComplete: true };
    await mountBound();
    fireEvent.click(await screen.findByRole("button", { name: "apps/docs" }));
    await waitFor(() =>
      expect(host.calls("openWorkspace").at(-1)).toMatchObject({ appPath: "apps/docs" })
    );
    await waitFor(() => expect(screen.queryByRole("button", { name: "apps/docs" })).toBeNull());
  });

  it("opens the workspace for its own preview and page, and listens on the picker's own channels", async () => {
    await mountBound();
    await waitFor(() =>
      expect(host.calls("openWorkspace").at(-1)).toEqual({
        panelId: "preview-1",
        worktreeId: "wt-1",
        // Source maps are fetched from the page's own origin and nowhere else.
        previewOrigin: "http://localhost:5173",
      })
    );
    expect(host.listenerCounts()).toEqual({ event: 1, source: 1 });
  });

  it("hands the host the directory the preview's dev server runs in, and doesn't ask which app", async () => {
    host.openWith = (request) =>
      request.serverCwd === "/repo/apps/docs"
        ? {
            status: "ready",
            workspaceId: "ws-1",
            appPath: "apps/docs",
            appPaths: [".", "apps/docs"],
            scanComplete: true,
          }
        : { status: "ambiguous", appPaths: [".", "apps/docs"], scanComplete: true };
    usePanelStore.setState({
      panelsById: {
        "preview-1": {
          id: "preview-1",
          kind: "dev-preview",
          location: "grid",
          cwd: "/repo/apps/docs",
        },
      } as never,
    });
    await mountBound();
    await waitFor(() =>
      expect(host.calls("openWorkspace").at(-1)).toMatchObject({ serverCwd: "/repo/apps/docs" })
    );
    await waitFor(() => {
      const workspace = session().getSnapshot().workspace;
      expect(workspace.status === "ready" && workspace.appPath).toBe("apps/docs");
    });
    expect(screen.queryByRole("list", { name: "Choose site source" })).toBeNull();
  });

  it("keeps a way to switch apps after one was opened, and drops what belonged to the old one", async () => {
    const apps = ["apps/web", "apps/docs"];
    host.openWith = (request) => {
      const appPath = request.appPath ?? "apps/web";
      return {
        status: "ready",
        workspaceId: `ws-${appPath.split("/").pop()}`,
        appPath,
        appPaths: apps,
        scanComplete: true,
      };
    };
    usePanelStore.setState({
      panelsById: {
        "preview-1": {
          id: "preview-1",
          kind: "dev-preview",
          location: "grid",
          cwd: "/repo/apps/web",
        },
      } as never,
    });
    await mountBound();
    await act(async () => host.select(0));
    await screen.findByRole("combobox", { name: "Site source app" });
    expect(host.calls("resolve").at(-1)).toMatchObject({ workspaceId: "ws-web" });
    const controller = session();
    await act(async () => controller.switchApp("apps/docs"));
    await waitFor(() =>
      expect(host.calls("openWorkspace").at(-1)).toMatchObject({ appPath: "apps/docs" })
    );
    expect(host.calls("closeWorkspace")).toContainEqual({ workspaceId: "ws-web" });
    await waitFor(() => {
      const workspace = controller.getSnapshot().workspace;
      expect(workspace.status === "ready" && workspace.appPath).toBe("apps/docs");
    });
    // The selection was proven against the other app's source.
    expect(controller.getSnapshot().selection.status).toBe("none");
    // …and with nothing selected, the switcher is still there to switch back.
    await screen.findByRole("combobox", { name: "Site source app" });
  });

  it("lets a click held for one app's source go when the user switches to another", async () => {
    const answers: Array<(result: ElementPickerWorkspaceOpenResult) => void> = [];
    host.openWith = () => new Promise((resolve) => answers.push(resolve));
    await mountBound();
    await act(async () => host.select(0));
    expect(session().getSnapshot().selection.status).toBe("resolving");

    await act(async () => session().switchApp("apps/docs"));
    await waitFor(() => expect(answers.length).toBeGreaterThan(1));
    await act(async () =>
      answers.at(-1)?.({
        status: "ready",
        workspaceId: "ws-docs",
        appPath: "apps/docs",
        appPaths: [".", "apps/docs"],
        scanComplete: true,
      })
    );
    // The click was made against the other app: it is never resolved against this one.
    await waitFor(() => expect(session().getSnapshot().workspace.status).toBe("ready"));
    expect(host.calls("resolve")).toEqual([]);
    expect(session().getSnapshot().selection.status).toBe("none");
  });

  it("won't trace a preview whose dev server runs from another worktree", async () => {
    usePanelStore.setState({
      panelsById: {
        "preview-1": { id: "preview-1", kind: "dev-preview", location: "grid", cwd: "/elsewhere" },
      } as never,
    });
    await mountBound();
    await screen.findAllByText(/runs from another worktree/);
    expect(host.calls("openWorkspace")).toHaveLength(0);
  });

  it("traces and offers the agent on an app the compiler was never tested against", async () => {
    host.describeWith = () =>
      sveltekitProject({
        verdict: "untested",
        reasons: ["svelte 4.2.1 is installed; the Element Picker is tested against svelte 5"],
      });
    await mountBound();
    await waitFor(() => expect(host.picker.describeProject).toHaveBeenCalled());
    // The verdict costs the user nothing, so it does not open the drawer and
    // does not touch the strip: what the picker offers — trace an element,
    // hand it to an agent — is the same either way.
    expect(screen.queryByRole("region", { name: "Site source" })).toBeNull();
    expect(screen.queryByText(/tested against svelte 5/)).toBeNull();
    await act(async () => host.select(0));
    await screen.findByRole("textbox", { name: "Request for the agent" });
    expect(host.calls("resolve")).toHaveLength(1);
    expect(screen.getByRole("region", { name: "Selected element" }).textContent).toContain(
      `${FILE}:6`
    );
    // Once the drawer is open for the selection, the verdict is readable there
    // as an observation about our compiler — a version and a package, no
    // recovery action, nothing about a capability being withheld.
    const siteSource = screen.getByRole("region", { name: "Site source" });
    expect(siteSource.textContent).toContain("Toolchain not verified");
    expect(siteSource.textContent).toContain("svelte 4.2.1 is installed");
    expect(siteSource.textContent).not.toMatch(/preview[- ]only/i);
    // Nothing to do about it, so no control and no live region — it is read,
    // not answered.
    expect(within(siteSource).queryAllByRole("button")).toEqual([]);
    expect(within(siteSource).queryByRole("alert")).toBeNull();
    expect(within(siteSource).queryByRole("status")).toBeNull();
  });

  it("says the search stopped rather than implying the worktree's apps are all listed", async () => {
    host.openWith = () => ({
      status: "ambiguous",
      appPaths: ["apps/web", "apps/docs"],
      scanComplete: false,
    });
    await mountBound();
    await screen.findByText(/The search stopped early/);
  });
});

describe("a location the page got wrong", () => {
  /** The host read the file the page named and found no such element there. */
  function mismatch(): ResolutionResult[] {
    return [
      {
        state: "unavailable",
        candidateId: STAMP.candidateId,
        claim: "template-location",
        reason: "mismatch",
        read: { file: { workspaceId: WORKSPACE, path: FILE }, fileRevision: REVISION },
      },
    ];
  }

  it("says what the page claimed and that the file doesn't hold it, not that the page changed", async () => {
    // A hydrated SvelteKit page can tag an element with a neighbour's location
    // (Svelte's dev `add_locations` counts a child component's root while
    // hydrating). Nothing changed, and selecting again gives the same answer,
    // so "Page changed — select it again" would be wrong twice over.
    host.resultsFor = () => mismatch();
    await mountBound();
    await act(async () => host.select(0));
    // A warning with its way out beside it, not an alert: nothing failed.
    await screen.findAllByText("Reported location doesn't match the file");
    expect(screen.queryByRole("alert")).toBeNull();
    const notice = screen
      .getAllByRole("status")
      .find((element) => element.textContent?.includes("doesn't hold it there"));
    expect(notice?.textContent).toContain(`<button> at ${FILE}:6`);
    expect(screen.getAllByRole("button", { name: "Switch to Browse" }).length).toBeGreaterThan(0);
    expect(text()).not.toContain("Page changed");
  });

  it("reads the disagreement as the page catching up when the file just changed", async () => {
    // An agent edits the file and the page has not re-rendered yet: the old
    // location now names something else. That is the usual settling case, not
    // a wrong location, and must not carry the hydration advice.
    host.resultsFor = () => mismatch();
    await mountBound();
    // One clock for the settle window's timer and the change's age.
    vi.useFakeTimers();
    await act(async () => host.sourceChanged(FILE));
    await act(async () => host.select(0));
    // The click is kept and asked for again once the page has caught up…
    await elapse(UI_DOHERTY_THRESHOLD);
    expect(screen.getAllByText("Waiting for the preview to update").length).toBeGreaterThan(0);
    expect(host.picker.reselect).not.toHaveBeenCalled();
    expect(text()).not.toContain("neighbour");
    await elapse(HMR_SETTLE_MS - UI_DOHERTY_THRESHOLD);
    expect(host.picker.reselect).toHaveBeenCalledTimes(1);
    // …and is the user's to repeat only when the page still can't vouch for
    // it. The page's answer arrives a tick after the ask.
    await elapse(10);
    expect(screen.getAllByText("File changed — select it again").length).toBeGreaterThan(0);
    expect(host.picker.reselect).toHaveBeenCalledTimes(1);
    // Nothing is left scheduled to ask again.
    await elapse(HMR_SETTLE_MS * 10);
    expect(host.picker.reselect).toHaveBeenCalledTimes(1);
    expect(text()).not.toContain("neighbour");
  });

  it("still reports a stale answer, with nothing changed to explain it, as the page having moved on", async () => {
    host.resultsFor = () => [
      {
        state: "stale",
        candidateId: STAMP.candidateId,
        claim: "template-location",
        held: {
          state: "verified",
          target: { file: { workspaceId: WORKSPACE, path: FILE }, location: STAMP.location },
          fileRevision: REVISION,
        },
        currentFileRevision: sha("newer"),
        reason: "file-changed",
      },
    ];
    await mountBound();
    await act(async () => host.select(0));
    await screen.findAllByText("Page changed — select it again");
  });
});

describe("selection identity", () => {
  it("resolves a selection and renders owner, line and a breadcrumb without generated frames", async () => {
    await mountSelected();
    const [request] = host.calls("resolve");
    expect(request).toMatchObject({
      sessionId: "session-1",
      workspaceId: "ws-1",
      documentEpoch: 0,
    });
    expect(request!.observations).toHaveLength(1);
    // The host traces source; what the page says the element looks like is
    // not part of what it is asked.
    expect(request!.observations.some((observation) => "context" in observation)).toBe(false);
    // Named once: the drawer's identity block carries the source, and the strip
    // repeats it only while the drawer is not there to show it.
    const identity = screen.getByRole("region", { name: "Selected element" });
    expect(identity.textContent).toContain(`${FILE}:6`);
    expect(screen.getByRole("toolbar", { name: "Element Picker" }).textContent).not.toContain(
      `${FILE}:6`
    );
    // The trail names the components this element was reached through, and
    // nothing else: generated framework frames are not the user's code, and
    // `each` is control flow — never a step. Asserted as that rule rather than
    // as a fixed list, so the trail can be restyled without rewriting this.
    const trail = screen.getAllByRole("navigation", { name: "Breadcrumb" })[0]!;
    const crumbs = Array.from(trail.querySelectorAll("li")).map((li) =>
      (li.textContent ?? "").trim()
    );
    expect(crumbs).toContain("PricingCard");
    expect(crumbs.some((crumb) => crumb.includes("each"))).toBe(false);
    expect(crumbs.some((crumb) => crumb.includes(SHELL.name!.value))).toBe(false);
    // It ends at what was picked, and marks it as current.
    expect(trail.querySelector('[aria-current="true"]')?.textContent).toContain("Start Pro");
  });

  it("names a picked component by the file the host followed its import to, never the element's", async () => {
    const followed = host.resultsFor;
    // The host proved the call site but couldn't follow its import.
    host.resultsFor = () =>
      svelteResults().map((result) =>
        result.candidateId === CARD_CALL.candidateId && result.state === "verified"
          ? { ...result, definition: undefined }
          : result
      );
    await mountBound();
    await act(async () =>
      host.select(0, [svelteObservation()], "user", {
        kind: "component",
        componentId: CARD.componentId,
      })
    );
    const identity = await screen.findByRole("region", { name: "Selected element" });
    // Named, but no file claimed for it — not even the file of the element it
    // was reached through.
    expect(identity.textContent).toContain("PricingCard");
    // The header names the component, so the slot says only the sentence.
    expect(within(identity).getByText("Couldn't find the source", { exact: true })).toBeTruthy();
    expect(identity.textContent).not.toContain(`${FILE}:6`);
    const strip = screen.getByRole("toolbar", { name: "Element Picker" });
    expect(strip.textContent).not.toContain(`${FILE}:6`);

    host.resultsFor = followed;
    await act(async () =>
      host.select(0, [svelteObservation()], "user", {
        kind: "component",
        componentId: CARD.componentId,
      })
    );
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Selected element" }).textContent).toContain(
        CARD_FILE
      )
    );
    // The strip defers to the open drawer for the file.
    expect(strip.textContent).not.toContain(CARD_FILE);
    // And the checked target draws the file it points the agent at, in the
    // composer itself rather than behind a hover.
    expect(screen.getByRole("radio", { name: "PricingCard", checked: true })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Ask an agent" }).textContent).toContain(CARD_FILE);
  });

  it("won't send a request about a component nobody found the file of, and offers what it can be about", async () => {
    host.resultsFor = () =>
      svelteResults().map((result) =>
        result.candidateId === CARD_CALL.candidateId && result.state === "verified"
          ? { ...result, definition: undefined }
          : result
      );
    await mountBound();
    await act(async () =>
      host.select(0, [svelteObservation()], "user", {
        kind: "component",
        componentId: CARD.componentId,
      })
    );
    const request = await screen.findByRole("textbox", { name: "Request for the agent" });
    fireEvent.change(request, { target: { value: "Make the card pop" } });
    const sendButton = () => screen.getByRole("button", { name: SEND_NAME }) as HTMLButtonElement;
    expect(isOff(sendButton())).toBe(true);
    // The identity says it under the name in its header; the note says it again
    // only as far as it must, naming the target and what to do.
    expect(sendNote()).toBe("Couldn't find the source for PricingCard — choose another target");
    expect(
      within(screen.getByRole("region", { name: "Selected element" })).getByText(
        "Couldn't find the source",
        { exact: true }
      )
    ).toBeTruthy();
    // The element itself is still something the request can be about.
    fireEvent.click(screen.getByRole("radio", { name: "Element" }));
    await waitFor(() => expect(isOff(sendButton())).toBe(false));
  });

  it("shows a React element's components and the line its creation maps to", async () => {
    host.template = () => reactObservation();
    await mountBound();
    await act(async () => host.select(0));
    const identity = await screen.findByRole("region", { name: "Selected element" });
    await waitFor(() => expect(identity.textContent).toContain("src/Dashboard.tsx:40"));
    // Outermost first, as every breadcrumb in the product runs, from the
    // render edges the page reported.
    const trail = within(screen.getByRole("toolbar", { name: "Element Picker" })).getByRole(
      "navigation",
      { name: "Breadcrumb" }
    );
    // The trail's own list, not the hidden row it measures crumbs in.
    const crumbs = Array.from(trail.querySelectorAll("li"))
      .filter((li) => li.closest('[aria-hidden="true"]') === null)
      .map((li) => (li.textContent ?? "").trim());
    expect(crumbs).toEqual(["Toolbar", "SaveButton", "button.save"]);
    // The host mapped the frames without reading the files: nothing is cited
    // as checked, so a request carries no revisions to hold.
    const state = session().getSnapshot().selection;
    if (state.status !== "ready") throw new Error("not ready");
    expect(citedRevisions(state.selection)).toEqual({});
  });

  it("selects a React component from a crumb by the id the page gave it", async () => {
    // React has no locator, so a crumb is asked for by the component's id in
    // this document, and only one the page reported roots for can be asked.
    host.template = () => reactObservation();
    await mountBound();
    await act(async () => host.select(0));
    await screen.findByRole("region", { name: "Selected element" });
    expect(session().componentSelection()).toBe("id");
    const strip = screen.getByRole("toolbar", { name: "Element Picker" });
    for (const trail of screen.getAllByRole("navigation", { name: "Breadcrumb" })) {
      expect(enabledButtons(trail, "SaveButton")).toHaveLength(1);
      expect(enabledButtons(trail, "Toolbar")).toHaveLength(0);
    }

    fireEvent.click(within(strip).getByRole("button", { name: "SaveButton" }));
    expect(host.picker.reselect).toHaveBeenCalledTimes(1);
    expect(host.picker.reselect.mock.calls[0]![0]).toEqual({
      sessionId: "session-1",
      elementId: "el-r",
      framework: "react",
      componentId: "r-save",
      reveal: true,
    });
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Selected element" }).textContent).toContain(
        "Component"
      )
    );
  });

  it("asks nothing by id once the document the element was proved in is gone", async () => {
    host.template = () => reactObservation();
    await mountBound();
    await act(async () => host.select(0));
    await screen.findByRole("region", { name: "Selected element" });
    const controller = session();
    const target = {
      componentId: "r-save",
      framework: "react" as const,
      usedAt: null,
      rendered: true,
    };
    // Toolbar reported no roots: there is nothing an id could select.
    await expect(
      controller.selectComponent({ ...target, componentId: "r-toolbar", rendered: false })
    ).resolves.toBe(false);
    expect(host.picker.reselect).not.toHaveBeenCalled();
    await act(async () => host.documentReady(1));
    expect(controller.componentSelection()).toBeNull();
    await expect(controller.selectComponent(target)).resolves.toBe(false);
    expect(host.picker.reselect).not.toHaveBeenCalled();
  });
});

describe("starting a fresh agent", () => {
  it("offers the agents the host can launch, not a fixed three", async () => {
    const { useCliAvailabilityStore } = await import("@/store/cliAvailabilityStore");
    const previous = useCliAvailabilityStore.getState();
    useCliAvailabilityStore.setState({
      isInitialized: true,
      // Blocked is installed but can't launch; Grok launches but can't be seen
      // waiting at its prompt, so a request can't be typed into it safely.
      availability: {
        claude: "blocked",
        codex: "missing",
        gemini: "missing",
        grok: "ready",
        opencode: "ready",
      },
    } as never);
    try {
      usePanelStore.setState({
        panelsById: {
          "preview-1": {
            id: "preview-1",
            kind: "dev-preview",
            location: "grid",
            worktreeId: "wt-1",
          },
        } as never,
      });
      useDevPreviewToolStore.setState({ activeByPanel: { "preview-1": ELEMENT_PICKER_TOOL_ID } });
      const { actionService } = await import("@/services/ActionService");
      const dispatch = vi
        .spyOn(actionService, "dispatch")
        .mockImplementation((async () => ({ ok: false, error: { message: "stop" } })) as never);
      await mountSelected();
      const request = screen.getByRole("textbox", { name: "Request for the agent" });
      fireEvent.change(request, { target: { value: "Say Upgrade" } });
      const sendButton = screen.getByRole("button", { name: SEND_NAME }) as HTMLButtonElement;
      await waitFor(() => expect(isOff(sendButton)).toBe(false));
      fireEvent.click(sendButton);
      await waitFor(() =>
        expect(dispatch).toHaveBeenCalledWith(
          "agent.launch",
          expect.objectContaining({ agentId: "opencode" }),
          expect.anything()
        )
      );
    } finally {
      useCliAvailabilityStore.setState(previous);
    }
  });
});

/** Svelte's component chain, innermost first, as a page reports `__svelte_meta.parent`. */
function svelteChain(
  calls: Array<{ id: string; name: string; file: string; line: number; column: number }>
): SelectionObservation {
  const records = calls.map((call, index) =>
    svelteRecord(call.id, call.name, {
      ...CARD_CALL,
      candidateId: `call-${index}`,
      file: call.file,
      location: {
        lineBase: 1,
        columnBase: 0,
        columnUnit: "utf16",
        line: call.line,
        column: call.column,
      },
    })
  );
  const base = svelteObservation();
  return {
    ...base,
    componentChain: {
      nearestId: records[0]?.componentId ?? null,
      components: records,
      truncated: false,
    },
    frameworkEvidence: [
      {
        kind: "svelte",
        ancestry: calls.map((call) => ({
          type: "component",
          file: call.file,
          line: call.line,
          column: call.column,
          componentTag: call.name,
        })),
        sameLocCount: 3,
        locIndex: 2,
        unmapped: false,
      },
    ],
  };
}

describe("request scope", () => {
  it("lists a deep chain with repeated names instead of squeezing it into segments", async () => {
    const chain = svelteChain(
      ["Card", "Grid", "Card", "Section", "Layout"].map((name, depth) => ({
        id: `c-${depth}`,
        name,
        file: `src/lib/${name}${depth}.svelte`,
        line: depth + 2,
        column: 0,
      }))
    );
    host.template = () => chain;
    await mountBound();
    await act(async () => host.select(0));
    await screen.findByRole("combobox", { name: "What the request targets" });
    // A list, not a row of segments: no scope radio is drawn beside the picker.
    expect(screen.queryByRole("radiogroup", { name: "What the request targets" })).toBeNull();
    expect(screen.queryByRole("radio", { name: "Element" })).toBeNull();
  });
});

describe("an app inside a monorepo", () => {
  it("opens and copies a picked component's file as the host resolved it, from the worktree", async () => {
    host.openWith = () => ({
      status: "ready",
      workspaceId: "ws-1",
      appPath: "apps/site",
      appPaths: ["apps/site"],
      scanComplete: true,
    });
    // The host contains reads to the app and names every file from the worktree.
    host.resultsFor = () =>
      svelteResults().map((result) =>
        result.candidateId === CARD_CALL.candidateId && result.state === "verified"
          ? {
              ...result,
              definition: {
                file: { workspaceId: WORKSPACE, path: "apps/site/src/lib/Card.svelte" },
                fileRevision: CARD_REVISION,
                specifier: "$lib/Card.svelte",
              },
            }
          : result
      );
    const { actionService } = await import("@/services/ActionService");
    const dispatch = vi.spyOn(actionService, "dispatch").mockResolvedValue({ ok: true } as never);
    await mountBound();
    await act(async () =>
      host.select(0, [svelteObservation()], "user", {
        kind: "component",
        componentId: CARD.componentId,
      })
    );
    const identity = await screen.findByRole("region", { name: "Selected element" });
    await waitFor(() => expect(identity.textContent).toContain("apps/site/src/lib/Card.svelte"));
    fireEvent.click(within(identity).getByRole("button", { name: "Open in editor" }));
    expect(dispatch).toHaveBeenCalledWith(
      "file.openInEditor",
      { path: "/repo/apps/site/src/lib/Card.svelte" },
      { source: "user" }
    );
  });
});

/** A claude terminal in the worktree, which the host reads as busy. */
function busyAgentBeside() {
  usePanelStore.setState({
    // `panelIds` as well as `panelsById`: the composer's target list walks the
    // id order, so a terminal present only in the map is invisible to it.
    panelIds: ["preview-1", "term-busy"],
    panelsById: {
      "preview-1": { id: "preview-1", kind: "dev-preview", location: "grid", worktreeId: "wt-1" },
      "term-busy": {
        id: "term-busy",
        kind: "terminal",
        location: "grid",
        worktreeId: "wt-1",
        hasPty: true,
        title: "claude · pricing polish",
        launchAgentId: "claude",
        detectedAgentId: "claude",
        agentState: "working",
      },
    } as never,
  });
}

describe("the composer", () => {
  it("won't send a request about a selection the page has moved past, and keeps the draft", async () => {
    await mountSelected();
    const request = screen.getByRole("textbox", { name: "Request for the agent" });
    fireEvent.change(request, { target: { value: "Say Upgrade" } });
    const sendButton = () => screen.getByRole("button", { name: SEND_NAME }) as HTMLButtonElement;
    expect(isOff(sendButton())).toBe(false);

    host.reselectFinds = false;
    await act(async () => host.epochAdvanced(1));
    // Blocked from the moment the page moved, not from when the panel gives up
    // asking the new page for it: unproven is unsendable either way.
    await waitFor(() => expect(isOff(sendButton())).toBe(true));
    expect((request as HTMLTextAreaElement).value).toBe("Say Upgrade");
  });

  it("reports terminal activity without blocking the send, since that reading is a guess", async () => {
    // The panel may say what it SAW in the terminal, but a passive output
    // heuristic must never be the thing that stops a request going out: agent
    // state is frequently wrong, and the advice it offers cannot clear a
    // reading that is stuck.
    busyAgentBeside();
    await mountSelected();
    const request = screen.getByRole("textbox", { name: "Request for the agent" });
    fireEvent.change(request, { target: { value: "Say Upgrade" } });
    const send = () => screen.getByRole("button", { name: SEND_NAME }) as HTMLButtonElement;
    await waitFor(() => expect(isOff(send())).toBe(false));
    // And it is surfaced as an observation rather than swallowed.
    expect(text()).toMatch(/The terminal is showing activity/);
  });

  it("headlines a delivery with what was proven, never with a reading of the agent", async () => {
    // The receipt's title states the one thing the host can vouch for — that
    // the request was sent. Anything inferred from terminal output may appear,
    // but only below it and only named as something observed.
    busyAgentBeside();
    await mountSelected();
    updateComposerMemory(composerMemoryKey("preview-1", "wt-1"), {
      draft: "",
      deliveries: [
        {
          id: "request-1",
          instruction: "Say Upgrade",
          subject: null,
          state: { status: "sent" },
          title: "claude · pricing polish",
          terminalId: "term-busy",
        },
      ],
    });
    // The request's row: its heading is the state and where it went.
    const queue = await screen.findByRole("list", { name: "Requests" });
    const row = within(queue).getAllByRole("listitem")[0]!;
    const headline = within(row).getByText(/^Sent to /).textContent ?? "";
    expect(headline).toContain("claude · pricing polish");
    expect(headline).not.toMatch(/working|activity/i);
    // And the observation is not suppressed either — it just lives below the
    // headline, where it reads as something seen rather than something proven.
    expect(row.textContent ?? "").toMatch(/activity/i);
  });

  it("inserts exactly the words a suggestion's chip shows", async () => {
    // A chip must never put words into the draft that the user could not read
    // on it before clicking.
    await mountSelected();
    const chips = within(screen.getByRole("group", { name: "Suggestions" })).getAllByRole("button");
    expect(chips.length).toBeGreaterThan(0);
    const chip = chips[0]!;
    const words = chip.textContent?.trim() ?? "";
    expect(words.length).toBeGreaterThan(0);
    fireEvent.click(chip);
    const request = screen.getByRole("textbox", {
      name: "Request for the agent",
    }) as HTMLTextAreaElement;
    await waitFor(() => expect(request.value).toBe(words));
  });

  it("names the composer as a group, so it is reachable without a visible heading", async () => {
    await mountSelected();
    expect(screen.getByRole("group", { name: "Ask an agent" })).toBeTruthy();
  });

  it("won't type a new request on top of one that may be half-way into the agent's input", async () => {
    // When a delivery failed AFTER typing had started, the panel tells the user
    // to check the terminal first — so Send must not still be armed: whatever
    // goes in next is appended to what is already sitting there.
    await mountSelected();
    const request = screen.getByRole("textbox", { name: "Request for the agent" });
    fireEvent.change(request, { target: { value: "Round the corners" } });
    const sendButton = () => screen.getByRole("button", { name: SEND_NAME }) as HTMLButtonElement;
    expect(isOff(sendButton())).toBe(false);

    act(() => {
      updateComposerMemory(composerMemoryKey("preview-1", "wt-1"), {
        deliveries: [
          {
            id: "request-1",
            instruction: "Say Upgrade",
            subject: null,
            state: {
              status: "failed",
              message: "The terminal stopped accepting input",
              partial: true,
            },
            title: "claude",
            terminalId: "term-1",
          },
        ],
      });
    });

    await waitFor(() => expect(isOff(sendButton())).toBe(true));
    // Answering the row is the acknowledgement.
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(isOff(sendButton())).toBe(false));
    expect((request as HTMLTextAreaElement).value).toBe("Round the corners");
  });

  it("won't re-send on Enter when delivery couldn't be confirmed, but sends when asked to", async () => {
    // The host lost track of the submission: the request may be in the agent
    // already. The unchanged draft must not go again on a casual Enter — and
    // the row's own Retry must actually send.
    usePanelStore.setState({
      panelsById: {
        "preview-1": { id: "preview-1", kind: "dev-preview", location: "grid", worktreeId: "wt-1" },
      } as never,
    });
    useDevPreviewToolStore.setState({ activeByPanel: { "preview-1": ELEMENT_PICKER_TOOL_ID } });
    const { actionService } = await import("@/services/ActionService");
    const sent: string[] = [];
    const dispatch = vi.spyOn(actionService, "dispatch").mockImplementation((async (
      id: string,
      args: Record<string, unknown>
    ) => {
      switch (id) {
        case "agent.launch":
          return { ok: true, result: { launched: true, terminalId: "term-9" } };
        case "terminal.getStatus":
          return {
            ok: true,
            result: {
              terminals: [
                {
                  terminalId: "term-9",
                  agentId: "claude",
                  spawnedAt: 1_000,
                  agentIncarnation: 0,
                  agentState: "waiting",
                  ...(args.submissionToken ? { submission: { phase: "pty_written" } } : {}),
                },
              ],
            },
          };
        case "terminal.sendCommand":
          sent.push(String(args.command));
          return { ok: true, result: { submissionToken: `token-${sent.length}` } };
        default:
          return { ok: false, error: { message: `unexpected ${id}` } };
      }
    }) as never);
    await mountSelected();
    const request = screen.getByRole("textbox", { name: "Request for the agent" });
    fireEvent.change(request, { target: { value: "Say Upgrade" } });
    const sendButton = () => screen.getByRole("button", { name: SEND_NAME }) as HTMLButtonElement;
    await waitFor(() => expect(isOff(sendButton())).toBe(false));

    // What the row was about travels with it, which is what lets it be sent
    // again: the pin the composer made when the words were typed.
    const key = composerMemoryKey("preview-1", "wt-1");
    const subject = await waitFor(() => {
      const pin = readComposerMemory(key).pinned;
      if (pin === null) throw new Error("not pinned yet");
      return pin;
    });
    act(() => {
      updateComposerMemory(key, {
        deliveries: [
          {
            id: "request-1",
            instruction: "Say Upgrade",
            subject,
            state: { status: "unconfirmed" },
            title: "claude",
            terminalId: "term-1",
          },
        ],
      });
    });
    await waitFor(() => expect(isOff(sendButton())).toBe(true));
    const before = dispatch.mock.calls.length;
    fireEvent.keyDown(request, { key: "Enter" });
    await act(async () => {});
    expect(dispatch.mock.calls.length).toBe(before);
    expect(text()).toContain("Unconfirmed in claude");

    expect(sent).toEqual([]);

    // Its session is gone, so Retry names where it goes instead.
    fireEvent.click(screen.getByRole("button", { name: /^Retry in New .+ session$/ }));
    // A new run, all the way to the terminal: exactly one more submission.
    await waitFor(() => expect(sent).toHaveLength(1), { timeout: 4000 });
    expect(sent[0]).toContain("Say Upgrade");
    // The row, not the status region that announces it in the same words.
    await within(screen.getByRole("list", { name: "Requests" })).findByText(/^Sent to /);
  });

  it("doesn't offer to send again when there is nothing it could send", async () => {
    await mountSelected();
    act(() => {
      updateComposerMemory(composerMemoryKey("preview-1", "wt-1"), {
        deliveries: [
          {
            id: "request-1",
            instruction: "Say Upgrade",
            subject: null,
            state: { status: "unconfirmed" },
            title: "claude",
            terminalId: "term-1",
          },
        ],
      });
    });
    await screen.findByText("Unconfirmed in claude");
    expect(screen.queryByRole("button", { name: /^Retry/ })).toBeNull();
  });

  it("hands a failed request's words back, and keeps a row open as its request moves on", async () => {
    await mountSelected();
    const key = composerMemoryKey("preview-1", "wt-1");
    const record = (state: { status: "queued" } | { status: "failed"; message: string }) => ({
      id: "request-1",
      instruction: "Round the corners",
      subject: null,
      state,
      title: "claude",
      terminalId: "term-1",
    });
    act(() => updateComposerMemory(key, { deliveries: [record({ status: "queued" })] }));
    fireEvent.click(await screen.findByRole("button", { name: /^Next for claude/ }));
    expect(screen.getByRole("group", { name: "Request text" }).textContent).toContain(
      "Round the corners"
    );

    // Its turn came and it could not go: the same request, a different state.
    act(() =>
      updateComposerMemory(key, {
        deliveries: [record({ status: "failed", message: "claude isn't running any more" })],
      })
    );
    await screen.findByText(/Nothing was typed into the agent/);
    expect(screen.getByRole("group", { name: "Request text" }).textContent).toContain(
      "Round the corners"
    );

    // They left the field when the request was accepted, so they come back.
    const request = screen.getByRole("textbox", {
      name: "Request for the agent",
    }) as HTMLTextAreaElement;
    expect(request.value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Edit request" }));
    await waitFor(() => expect(request.value).toBe("Round the corners"));
    expect(screen.queryByRole("list", { name: "Requests" })).toBeNull();
  });

  it("shows a request sent while the agent is busy as queued, with its words a click away", async () => {
    await mountSelected();
    act(() => {
      updateComposerMemory(composerMemoryKey("preview-1", "wt-1"), {
        deliveries: [
          {
            id: "request-1",
            instruction: "Make it green",
            subject: null,
            state: { status: "sent" },
            title: "claude",
            terminalId: "term-1",
            request: "Make it green\n\n---\n- Source: <button> at src/lib/PricingCard.svelte:6:2",
          },
          {
            id: "request-2",
            instruction: "Round the corners",
            subject: null,
            state: { status: "queued" },
            title: "claude",
            terminalId: "term-1",
          },
          {
            id: "request-3",
            instruction: "Add a hover state",
            subject: null,
            state: { status: "queued" },
            title: "claude",
            terminalId: "term-1",
          },
        ],
      });
    });
    const queue = await screen.findByRole("list", { name: "Requests" });
    expect(within(queue).getAllByRole("listitem")).toHaveLength(3);
    // Waiting is not a warning: nothing here asks the user to do anything.
    expect(within(queue).queryByRole("alert")).toBeNull();
    expect(text()).not.toMatch(/No sign yet/);
    // And it never blocks the next request.
    fireEvent.change(screen.getByRole("textbox", { name: "Request for the agent" }), {
      target: { value: "One more thing" },
    });
    const send = screen.getByRole("button", { name: SEND_NAME }) as HTMLButtonElement;
    await waitFor(() => expect(isOff(send)).toBe(false));

    // Only the request at the head can be pushed on; either can be taken out.
    const rows = within(queue).getAllByRole("button", { name: /^(Next|Queued) for claude/ });
    expect(rows).toHaveLength(2);
    fireEvent.click(rows[0]!);
    expect(within(queue).getAllByRole("button", { name: "Send now" })).toHaveLength(1);
    fireEvent.click(rows[1]!);
    expect(within(queue).getAllByRole("button", { name: "Send now" })).toHaveLength(1);
    const texts = within(queue).getAllByRole("group", { name: "Request text" });
    expect(texts.map((node) => node.querySelector("pre")?.textContent)).toEqual([
      "Round the corners",
      "Add a hover state",
    ]);

    fireEvent.click(within(queue).getAllByRole("button", { name: "Remove" })[1]!);
    await waitFor(() => expect(within(queue).getAllByRole("listitem")).toHaveLength(2));
    expect(queue.textContent).not.toContain("Add a hover state");
  });

  it("still allows an immediate retry when nothing was typed into the agent", async () => {
    // A failure BEFORE any bytes went out leaves nothing to check, so blocking
    // the send would be friction with no payoff.
    await mountSelected();
    const request = screen.getByRole("textbox", { name: "Request for the agent" });
    fireEvent.change(request, { target: { value: "Say Upgrade" } });
    act(() => {
      updateComposerMemory(composerMemoryKey("preview-1", "wt-1"), {
        deliveries: [
          {
            id: "request-1",
            instruction: "Say Upgrade",
            subject: null,
            state: { status: "failed", message: "The terminal was gone" },
            title: "claude",
            terminalId: "term-1",
          },
        ],
      });
    });
    const sendButton = () => screen.getByRole("button", { name: SEND_NAME }) as HTMLButtonElement;
    await screen.findByText("Couldn't send to claude");
    expect(isOff(sendButton())).toBe(false);
  });
});

describe("selecting a component from the trail", () => {
  it("names the selection as current in the trail, never an ancestor", async () => {
    // The drawer hides the terminal crumb because its header already names the
    // element; marking whatever crumb is left as `aria-current` would tell a
    // screen reader the parent component was the selection.
    await mountSelected();
    for (const trail of screen.getAllByRole("navigation", { name: "Breadcrumb" })) {
      const current = trail.querySelector('[aria-current="true"]');
      expect(current).not.toBeNull();
      expect(current!.textContent).toContain("Start Pro");
      expect(current!.textContent).not.toBe("PricingCard");
    }
  });

  it("selects the component a crumb names, as the page would on Option+Up", async () => {
    // Each step of the trail asks the page to re-select the proven element as
    // a member of that invocation — by call site, never by label, since two
    // nested components can share a name.
    await mountSelected();
    const strip = screen.getByRole("toolbar", { name: "Element Picker" });
    const identity = screen.getByRole("region", { name: "Selected element" });
    for (const surface of [strip, identity]) {
      expect(within(surface).getByRole("button", { name: "PricingCard" })).toBeTruthy();
    }
    // The element is where you already are: nothing to act on.
    expect(enabledButtons(strip, 'button "Start Pro"')).toHaveLength(0);

    fireEvent.click(within(identity).getByRole("button", { name: "PricingCard" }));
    expect(host.picker.reselect).toHaveBeenCalledTimes(1);
    expect(host.picker.reselect.mock.calls[0]![0]).toEqual({
      sessionId: "session-1",
      // By the id the page reported it under first, while it is still that node.
      elementId: "el-1",
      framework: "svelte",
      locator: {
        loc: { file: FILE, line: 6, column: 2 },
        index: 2,
        component: { file: CARD_CALL.file, line: 3, column: 0 },
      },
      // Picked from the trail, so it is brought into view.
      reveal: true,
    });
    // The page's answer is a component selection, and both surfaces follow it.
    // The identity block is remounted by the resolve, so it is read afresh.
    const reselected = () => screen.getByRole("region", { name: "Selected element" });
    await waitFor(() => expect(reselected().textContent).toContain("Component"));
    expect(within(reselected()).getByText("PricingCard")).toBeTruthy();
    const trail = within(strip).getByRole("navigation", { name: "Breadcrumb" });
    expect(trail.textContent).not.toContain("Start Pro");
    expect(trail.querySelector('[aria-current="true"]')?.textContent).toBe("PricingCard");
    // Now the selection: no longer a control in either surface.
    expect(enabledButtons(strip, "PricingCard")).toHaveLength(0);
    expect(enabledButtons(reselected(), "PricingCard")).toHaveLength(0);
    // And the request is about it: the composer's About control follows the
    // page's answer, not the crumb.
    const about = within(reselected().parentElement!.parentElement!).getAllByRole("radio", {
      name: "PricingCard",
      checked: true,
    });
    expect(about).toHaveLength(1);
  });

  it("does not ask the page for a component while nothing is proven", async () => {
    await mountBound();
    const controller = session();
    await expect(
      controller.selectComponent({
        componentId: "s-card",
        framework: "svelte",
        usedAt: { file: CARD_CALL.file, line: 3, column: 0 },
        rendered: true,
      })
    ).resolves.toBe(false);
    expect(host.picker.reselect).not.toHaveBeenCalled();
  });

  it("selects the invocation a crumb names when two components share a name, and returns focus", async () => {
    // Layout > Card > Inner > Card > button: the outer Card is matched by its
    // call site, never by label; once it is the selection, the crumbs inside it
    // are the route the element was reached through, so they leave both
    // trails. A keyboard user's focus comes back to the strip's current crumb.
    const outer = { file: "src/routes/+layout.svelte", line: 12, column: 0 };
    host.template = () =>
      svelteChain([
        { id: "c-inner-card", name: "Card", file: "src/lib/Inner.svelte", line: 8, column: 2 },
        { id: "c-inner", name: "Inner", file: "src/lib/Card.svelte", line: 5, column: 4 },
        { id: "c-outer-card", name: "Card", ...outer },
        { id: "c-layout", name: "Layout", file: "src/App.svelte", line: 1, column: 0 },
      ]);
    await mountBound();
    await act(async () => host.select(0));
    await screen.findByRole("region", { name: "Selected element" });
    const strip = screen.getByRole("toolbar", { name: "Element Picker" });
    const cards = enabledButtons(strip, "Card");
    expect(cards).toHaveLength(2);
    cards[0]!.focus();
    fireEvent.click(cards[0]!);
    expect(host.picker.reselect.mock.calls[0]![0].locator).toMatchObject({ component: outer });

    const trail = () => within(strip).getByRole("navigation", { name: "Breadcrumb" });
    await waitFor(() => expect(trail().textContent).not.toContain("Inner"));
    const current = trail().querySelector('[aria-current="true"]')!;
    expect(current.textContent).toBe("Card");
    const layout = within(strip).getByRole("button", { name: "Layout" });
    expect(enabledButtons(strip, "Card")).toHaveLength(0);
    // On a control the toolbar's roving keys work from, not on the text that
    // replaced the button.
    expect(document.activeElement).toBe(layout);
    const identity = screen.getByRole("region", { name: "Selected element" });
    const drawerCrumbs = Array.from(
      within(identity).getByRole("navigation", { name: "Breadcrumb" }).querySelectorAll("li")
    )
      .filter((li) => !li.classList.contains("sr-only"))
      .filter((li) => li.closest('[aria-hidden="true"]') === null)
      .map((li) => (li.textContent ?? "").trim());
    expect(drawerCrumbs).toEqual(["Layout"]);
  });

  it("offers neither surface a crumb the page could only resolve to the selection", async () => {
    // A recursive component invoked from one line twice: the page matches a
    // call site innermost first, so the outer Tree can only ever select the
    // inner one — which is already the selection. The strip sees that in its
    // own crumbs; the drawer hides the current crumb and has to be told.
    const site = { file: "src/lib/Tree.svelte", line: 4, column: 2 };
    host.template = () =>
      svelteChain([
        { id: "t-inner", name: "Tree", ...site },
        { id: "t-middle", name: "Tree", ...site },
        { id: "t-outer", name: "Tree", file: "src/routes/+page.svelte", line: 9, column: 0 },
      ]);
    await mountBound();
    await act(async () =>
      host.select(0, [host.template()], "user", { kind: "component", componentId: "t-inner" })
    );
    const identity = await screen.findByRole("region", { name: "Selected element" });
    const strip = screen.getByRole("toolbar", { name: "Element Picker" });
    for (const surface of [strip, identity]) {
      expect(within(surface).getAllByText("Tree").length).toBeGreaterThan(0);
      // The outermost Tree, at its own call site, is still a step up.
      expect(enabledButtons(surface, "Tree")).toHaveLength(1);
    }
  });

  it("leaves the selection alone when the page no longer has the element", async () => {
    await mountSelected();
    host.reselectFinds = false;
    const before = session().getSnapshot();
    const strip = screen.getByRole("toolbar", { name: "Element Picker" });
    fireEvent.click(within(strip).getByRole("button", { name: "PricingCard" }));
    await waitFor(() => expect(host.picker.reselect).toHaveBeenCalledTimes(1));
    await act(async () => {});
    const after = session().getSnapshot();
    expect(after.selection).toBe(before.selection);
    expect(after.selectionGeneration).toBe(before.selectionGeneration);
    expect(host.calls("resolve")).toHaveLength(1);
    expect(within(strip).getByRole("button", { name: "PricingCard" })).toBeTruthy();
  });

  it("offers no crumb to click while browsing", async () => {
    // The page only answers a selection request in Inspect mode. A crumb that
    // is a button in Browse mode is a button that does nothing.
    await mountSelected();
    fireEvent.click(screen.getByRole("radio", { name: "Browse" }));
    await waitFor(() => expect(session().getSnapshot().mode).toBe("browse"));
    const strip = screen.getByRole("toolbar", { name: "Element Picker" });
    expect(within(strip).getByRole("navigation", { name: "Breadcrumb" }).textContent).toContain(
      "PricingCard"
    );
    expect(enabledButtons(strip, "PricingCard")).toHaveLength(0);
    const identity = screen.getByRole("region", { name: "Selected element" });
    expect(enabledButtons(identity, "PricingCard")).toHaveLength(0);
  });
});

/** The host actions a delivery goes through to an agent that is waiting at its prompt, every submission recorded. */
async function recordSends() {
  const { actionService } = await import("@/services/ActionService");
  const sent: string[] = [];
  vi.spyOn(actionService, "dispatch").mockImplementation((async (
    id: string,
    args: Record<string, unknown>
  ) => {
    switch (id) {
      case "agent.launch":
        return { ok: true, result: { launched: true, terminalId: "t" } };
      case "terminal.getStatus":
        return {
          ok: true,
          result: {
            terminals: [
              {
                terminalId: (args.terminalIds as string[] | undefined)?.[0] ?? "t",
                agentId: "claude",
                spawnedAt: 1_000,
                agentIncarnation: 0,
                agentState: "waiting",
                ...(args.submissionToken ? { submission: { phase: "pty_written" } } : {}),
              },
            ],
          },
        };
      case "terminal.sendCommand":
        sent.push(String(args.command));
        return { ok: true, result: { submissionToken: `token-${sent.length}` } };
      default:
        return { ok: false, error: { message: `unexpected ${id}` } };
    }
  }) as never);
  return sent;
}

async function sendRequest(sent: string[], words = "Make this bigger"): Promise<string> {
  const request = await screen.findByRole("textbox", { name: "Request for the agent" });
  fireEvent.change(request, { target: { value: words } });
  const send = () => screen.getByRole("button", { name: SEND_NAME }) as HTMLButtonElement;
  await waitFor(() => expect(isOff(send())).toBe(false));
  fireEvent.click(send());
  await waitFor(() => expect(sent).toHaveLength(1), { timeout: 4000 });
  return sent[0]!;
}

describe("revision checks before a request goes", () => {
  async function readySelection() {
    const controller = session();
    const state = controller.getSnapshot().selection;
    if (state.status !== "ready") throw new Error("not ready");
    return { controller, selection: state.selection };
  }

  it("holds a request to the bytes of every file it cites, not only the element's", async () => {
    await mountSelected();
    const { controller, selection } = await readySelection();
    // The card's definition, followed from the call site, is cited alongside
    // the element's file — each at the revision the host read it at.
    expect(citedRevisions(selection)).toEqual({ [FILE]: REVISION, [CARD_FILE]: CARD_REVISION });
    expect(await controller.sourcesUnchanged(selection)).toBe(true);
    expect(host.calls("sourceRevisions").at(-1)).toEqual({
      workspaceId: "ws-1",
      paths: expect.arrayContaining([FILE, CARD_FILE]),
    });

    host.diskRevisions.set(CARD_FILE, sha("an agent's edit"));
    expect(await controller.sourcesUnchanged(selection)).toBe(false);
    host.diskRevisions.set(CARD_FILE, null);
    expect(await controller.sourcesUnchanged(selection)).toBe(false);
  });

  it("keeps the revision a definition was read at, even if the file moved on before the pick landed", async () => {
    // The host followed the import at one revision; disk already holds another.
    host.diskRevisions.set(CARD_FILE, sha("newer card"));
    await mountSelected();
    const { controller, selection } = await readySelection();
    expect(citedRevisions(selection)[CARD_FILE]).toBe(CARD_REVISION);
    expect(await controller.sourcesUnchanged(selection)).toBe(false);
  });

  it("won't let one claim's revision paper over another read from other bytes of the same file", async () => {
    host.resultsFor = () =>
      svelteResults().map((result) =>
        result.candidateId === CARD_CALL.candidateId && result.state === "verified"
          ? { ...result, fileRevision: sha("the page file, read again") }
          : result
      );
    await mountSelected();
    const { controller, selection } = await readySelection();
    expect(citedRevisions(selection)[FILE]).toBeNull();
    expect(await controller.sourcesUnchanged(selection)).toBe(false);
  });

  it("can't vouch for a selection from a workspace it has since let go of", async () => {
    await mountSelected();
    const { controller, selection } = await readySelection();
    host.picker.sourceRevisions.mockImplementation(async () => {
      throw workspaceClosedError();
    });
    expect(await controller.sourcesUnchanged(selection)).toBe(false);
    // The host no longer holds it, so the picker opens it again.
    await waitFor(() => expect(host.calls("openWorkspace")).toHaveLength(2));
    expect(controller.getSnapshot().selection.status).toBe("none");
  });

  it("sends file references and the route around the page, never source text", async () => {
    host.describeWith = () =>
      sveltekitProject({
        route: {
          routeId: "/pricing",
          files: [
            { role: "layout", path: "src/routes/+layout.svelte" },
            { role: "data", path: "src/routes/pricing/+page.server.ts" },
            { role: "page", path: FILE },
          ],
        },
      });
    usePanelStore.setState({
      panelsById: {
        "preview-1": { id: "preview-1", kind: "dev-preview", location: "grid", worktreeId: "wt-1" },
      } as never,
    });
    useDevPreviewToolStore.setState({ activeByPanel: { "preview-1": ELEMENT_PICKER_TOOL_ID } });
    const sent = await recordSends();

    await mountSelected();
    const prompt = await sendRequest(sent, "Say Upgrade");

    expect(prompt).toContain("- Route files, outermost layout first:");
    expect(prompt).toContain("  - layout: src/routes/+layout.svelte");
    expect(prompt).toContain("  - data: src/routes/pricing/+page.server.ts");
    expect(prompt).toContain(`  - page: ${FILE}`);
    expect(prompt).toContain("(SvelteKit 2.15.0, Svelte 5.2.0, Tailwind 4.1.0)");
    expect(prompt).not.toContain("```");
    // The route was read for the page the selection is on, from the workspace it was proved in.
    expect(host.calls("describeProject").at(-1)).toEqual({
      workspaceId: "ws-1",
      url: "http://localhost:5173/pricing?plan=",
    });

    // The request's row keeps the exact request, one disclosure away.
    fireEvent.click(await screen.findByRole("button", { name: /^Sent to / }));
    expect(screen.getByRole("group", { name: "Request text" }).textContent).toBe(prompt);
    // Beside the status region, not inside it: a status is read out whole.
    expect(
      screen.getByRole("group", { name: "Request text" }).closest('[role="status"]')
    ).toBeNull();
  });
});

describe("keeping the selection's files watched", () => {
  const key = () => composerMemoryKey("preview-1", "wt-1");

  async function readySelection() {
    await mountSelected();
    const controller = session();
    const state = controller.getSnapshot().selection;
    if (state.status !== "ready") throw new Error("not ready");
    await waitFor(() => expect(host.calls("holdSources")).not.toHaveLength(0));
    return { controller, selection: state.selection };
  }

  /** The same selection about other files, as an older pick of another element would be. */
  function elsewhere(selection: PickedSelection, name: string): PickedSelection {
    const moved = JSON.stringify(selection)
      .replaceAll(FILE, `src/${name}/+page.svelte`)
      .replaceAll(CARD_FILE, `src/${name}/Card.svelte`);
    return { ...(JSON.parse(moved) as PickedSelection), selectionId: `${name}-selection` };
  }

  const delivery = (id: string, subject: PickedSelection, status: "queued" | "sent") => ({
    id,
    instruction: "Make it bigger",
    subject: { selection: subject, scope: 0 },
    state: { status },
    title: "claude",
    terminalId: "term-1",
  });

  it("holds the element's own file first, then the rest of the selection's, sending only a change", async () => {
    const { selection } = await readySelection();
    // A workspace opens holding nothing, so there was nothing to send before.
    expect(host.calls("holdSources")).toEqual([
      { workspaceId: WORKSPACE, paths: [FILE, CARD_FILE] },
    ]);

    // Pinning the same selection to a draft holds nothing new.
    act(() => updateComposerMemory(key(), { draft: "Make it", pinned: { selection, scope: 0 } }));
    act(() => updateComposerMemory(key(), { draft: "Make it bigger" }));
    expect(host.calls("holdSources")).toHaveLength(1);
  });

  it("keeps holding what a draft is pinned to after the selection goes, and lets go with the draft", async () => {
    const { controller, selection } = await readySelection();
    act(() => updateComposerMemory(key(), { draft: "Make it", pinned: { selection, scope: 0 } }));
    await act(async () => controller.clearSelection());
    expect(host.calls("holdSources")).toHaveLength(1);

    act(() => updateComposerMemory(key(), { draft: "", pinned: null }));
    expect(host.calls("holdSources").at(-1)).toEqual({ workspaceId: WORKSPACE, paths: [] });
  });

  it("ranks the draft's pin, then waiting requests newest first, and skips settled ones and other apps", async () => {
    const { selection } = await readySelection();
    const older = elsewhere(selection, "older");
    const newer = elsewhere(selection, "newer");
    const drafted = elsewhere(selection, "drafted");
    const settled = elsewhere(selection, "settled");
    const otherApp = {
      ...elsewhere(selection, "other"),
      workspaceId: "ws-gone",
      appPath: "apps/other",
    };
    act(() =>
      updateComposerMemory(key(), {
        draft: "Make it bigger",
        pinned: { selection: drafted, scope: 0 },
        deliveries: [
          delivery("r0", settled, "sent"),
          delivery("r1", older, "queued"),
          delivery("r2", otherApp, "queued"),
          delivery("r3", newer, "queued"),
        ],
      })
    );
    expect(host.calls("holdSources").at(-1)).toEqual({
      workspaceId: WORKSPACE,
      paths: [
        FILE,
        CARD_FILE,
        "src/drafted/+page.svelte",
        "src/drafted/Card.svelte",
        "src/newer/+page.svelte",
        "src/newer/Card.svelte",
        "src/older/+page.svelte",
        "src/older/Card.svelte",
      ],
    });
  });

  it("holds nothing for another preview's or worktree's composer", async () => {
    const { selection } = await readySelection();
    const pinned = { selection: elsewhere(selection, "drafted"), scope: 0 };
    act(() => {
      updateComposerMemory(composerMemoryKey("preview-2", "wt-1"), { draft: "x", pinned });
      updateComposerMemory(composerMemoryKey("preview-1", "wt-2"), { draft: "x", pinned });
    });
    expect(host.calls("holdSources")).toHaveLength(1);
  });

  it("stops holding when the picker is switched off", async () => {
    const { selection } = await readySelection();
    switchOff();
    act(() =>
      updateComposerMemory(key(), {
        draft: "x",
        pinned: { selection: elsewhere(selection, "drafted"), scope: 0 },
      })
    );
    expect(host.calls("holdSources")).toHaveLength(1);
  });
});

describe("stale selections", () => {
  it("goes stale when the page reloads and never answers for the selection", async () => {
    host.reselectFinds = false;
    await mountSelected();
    vi.useFakeTimers();
    await act(async () => host.epochAdvanced(1));
    // Asked first, a bounded number of times; then it is the user's to redo.
    expect(screen.queryAllByText("Page reloaded — select it again")).toHaveLength(0);
    await elapse(HMR_SETTLE_MS * 8);
    expect(screen.getAllByText("Page reloaded — select it again").length).toBeGreaterThan(0);
    // Said once in the identity and again under Send, in the same words.
    expectStaleAgrees("Page reloaded — select it again");
  });

  it("words a disconnected preview the same under Send as in the identity", async () => {
    await mountSelected();
    // Asked to disconnect, so nothing reattaches and the pick stays unproven.
    await act(async () =>
      host.pushPreview({
        kind: "detached",
        sessionId: "session-1",
        projectId: "p1",
        reason: "requested",
      })
    );
    expectStaleAgrees("Preview disconnected — select it again");
  });

  it("proves the selection again after its file changes, and the draft follows it", async () => {
    await mountSelected();
    await act(async () => host.sourceChanged("src/lib/Other.svelte"));
    // A change to another file leaves this selection alone.
    expect(host.picker.reselect).not.toHaveBeenCalled();

    fireEvent.change(screen.getByRole("textbox", { name: "Request for the agent" }), {
      target: { value: "Make it green" },
    });
    const send = screen.getByRole("button", { name: SEND_NAME }) as HTMLButtonElement;
    await waitFor(() => expect(isOff(send)).toBe(false));

    await act(async () => host.sourceChanged(FILE, sha("an agent's edit")));
    // Unproven, so it can't be sent — but nobody is told to click again yet,
    // and Send says what is happening instead of asking for a click.
    expect(isOff(send)).toBe(true);
    expect(screen.queryAllByText("File changed — select it again")).toHaveLength(0);
    expect(sendNote()).toBe("Checking this selection again");

    // Proved again as a new selection, which the pinned draft moves to: it is
    // sendable, and not offered its own subject as a different one.
    await waitFor(() => expect(isOff(send)).toBe(false), { timeout: 4000 });
    expect(host.calls("resolve")).toHaveLength(2);
    expect(host.picker.reselect).toHaveBeenCalledWith({
      sessionId: "session-1",
      elementId: "el-1",
      framework: "svelte",
      locator: { loc: { file: FILE, line: 6, column: 2 }, index: 2 },
    });
    expect(screen.queryByRole("button", { name: "Use current selection" })).toBeNull();
    expect(screen.queryAllByText("File changed — select it again")).toHaveLength(0);
    // The draft is about the selection proved again, which names the one it replaced.
    const live = session().getSnapshot().selection;
    if (live.status !== "ready") throw new Error("not ready");
    expect(live.supersedes).toHaveLength(1);
    const pinned = readComposerMemory(composerMemoryKey("preview-1", "wt-1")).pinned;
    expect(pinned?.selection.selectionId).toBe(live.selection.selectionId);
  });

  it("proves a change to a file only the selection's component lives in, too", async () => {
    // The card's definition was followed from the call site, so an edit to it
    // puts the request in doubt as much as an edit to the page's own file.
    await mountSelected();
    await act(async () => host.sourceChanged(CARD_FILE, sha("an agent's edit")));
    const state = session().getSnapshot().selection;
    expect(state.status === "ready" && state.stale).toBe("source-changed");
    await waitFor(() => expect(host.calls("resolve")).toHaveLength(2), { timeout: 4000 });
  });

  it("ignores a change pushed about another workspace", async () => {
    await mountSelected();
    await act(async () => host.sourceChanged(FILE, null, "ws-other"));
    const state = session().getSnapshot().selection;
    expect(state.status === "ready" && state.stale).toBeNull();
  });

  it("proves a React selection again by its element id after its file changes", async () => {
    host.template = () => reactObservation();
    await mountBound();
    await act(async () => host.select(0));
    const request = await screen.findByRole("textbox", { name: "Request for the agent" });
    fireEvent.change(request, { target: { value: "Make it green" } });
    const send = screen.getByRole("button", { name: SEND_NAME }) as HTMLButtonElement;
    await waitFor(() => expect(isOff(send)).toBe(false));

    // The creation site was mapped, not read: its file carries no revision,
    // and an edit to it moves the line all the same.
    await act(async () => host.sourceChanged("src/Dashboard.tsx"));
    expect(isOff(send)).toBe(true);
    await waitFor(() => expect(isOff(send)).toBe(false), { timeout: 4000 });
    // React gives the page no locator, so the same node is all it can be asked for.
    expect(host.picker.reselect).toHaveBeenCalledWith({
      sessionId: "session-1",
      elementId: "el-r",
    });
    expect(host.calls("resolve")).toHaveLength(2);
    expect(screen.getByRole("region", { name: "Selected element" }).textContent).toContain(
      "src/Dashboard.tsx:40"
    );
  });

  it("proves a React component selection again by the id it was selected by", async () => {
    host.template = () => reactObservation();
    await mountBound();
    await act(async () =>
      host.select(0, undefined, "user", { kind: "component", componentId: "r-save" })
    );
    await screen.findByRole("textbox", { name: "Request for the agent" });

    await act(async () => host.sourceChanged("src/Dashboard.tsx"));
    await waitFor(() => expect(host.picker.reselect).toHaveBeenCalled(), { timeout: 4000 });
    // SaveButton has no call site to aim at, so its id is what keeps it a component.
    expect(host.picker.reselect).toHaveBeenCalledWith({
      sessionId: "session-1",
      elementId: "el-r",
      framework: "react",
      componentId: "r-save",
    });
    await waitFor(() => {
      const state = session().getSnapshot().selection;
      expect(state.status === "ready" && state.stale === null && state.selection.scope).toEqual({
        kind: "component",
        componentId: "r-save",
      });
    });
  });

  it("asks again by element id for a React pick made while its file was still settling", async () => {
    host.template = () => reactObservation();
    await mountBound();
    vi.useFakeTimers();
    await act(async () => host.sourceChanged("src/Dashboard.tsx"));
    await act(async () => host.select(0));
    await elapse(HMR_SETTLE_MS);
    expect(host.picker.reselect).toHaveBeenCalledWith({
      sessionId: "session-1",
      elementId: "el-r",
    });
  });

  it("won't vouch for a mapped claim whose file was edited after the pick", async () => {
    host.template = () => reactObservation();
    await mountBound();
    await act(async () => host.select(0));
    await screen.findByRole("textbox", { name: "Request for the agent" });
    const ready = session().getSnapshot().selection;
    if (ready.status !== "ready") throw new Error("expected a ready selection");
    expect(await session().sourcesUnchanged(ready.selection)).toBe(true);

    await act(async () => host.sourceChanged("src/Dashboard.tsx"));
    // Even the selection as it was picked, which a queued request falls back to.
    expect(await session().sourcesUnchanged(ready.selection)).toBe(false);
  });

  it("can't find a React selection again after a reload, and says so", async () => {
    host.template = () => reactObservation();
    await mountBound();
    await act(async () => host.select(0));
    await screen.findByRole("region", { name: "Selected element" });
    await act(async () => host.documentReady(1));
    // An id from the old document names some other element now, and there is
    // no locator to ask by: nothing is asked.
    await screen.findAllByText("Page reloaded — select it again");
    expect(host.picker.reselect).not.toHaveBeenCalled();
  });

  it("refuses an element found by position when the copies at that position changed", async () => {
    await mountSelected();
    // A new node where the third of three cards was; now there are two.
    host.picker.reselect.mockImplementationOnce(async (request) => {
      const found = svelteObservation({
        elementId: "el-9",
        frameworkEvidence: [
          { ...svelteObservation().frameworkEvidence[0]!, sameLocCount: 2 } as never,
        ],
      });
      setTimeout(() => host.select(0, [found], "reselect"), 0);
      void request;
      return true;
    });
    await act(async () => host.sourceChanged(FILE));
    await screen.findAllByText("File changed — select it again", {}, { timeout: 4000 });
    expectStaleAgrees("File changed — select it again");
    expect(host.calls("resolve")).toHaveLength(1);
    // The page is outlining the stand-in; it is told to stop.
    expect(host.preview.clearSelection).toHaveBeenCalledWith({ sessionId: "session-1" });
  });

  it("does not take the element for the component that was selected", async () => {
    await mountBound();
    await act(async () =>
      host.select(0, [svelteObservation()], "user", {
        kind: "component",
        componentId: CARD.componentId,
      })
    );
    await screen.findByRole("region", { name: "Selected element" });
    // The page no longer finds that invocation and answers with the element.
    host.picker.reselect.mockImplementationOnce(async () => {
      setTimeout(() => host.select(0, [svelteObservation()], "reselect"), 0);
      return true;
    });
    await act(async () => host.sourceChanged(FILE));
    await screen.findAllByText("File changed — select it again", {}, { timeout: 4000 });
    expect(host.picker.reselect.mock.calls[0]![0].locator).toMatchObject({
      component: { file: CARD_CALL.file, line: 3, column: 0 },
    });
    expect(host.calls("resolve")).toHaveLength(1);
  });

  it("asks the reloaded page for the selection, since an edit reloads as often as it hot-updates", async () => {
    await mountSelected();
    await act(async () => host.sourceChanged(FILE));
    // A Tailwind class the stylesheet never held: the dev server reloads.
    await act(async () => host.documentReady(1));
    expect(screen.queryAllByText("Page reloaded — select it again")).toHaveLength(0);
    await waitFor(() => expect(host.calls("resolve")).toHaveLength(2), { timeout: 4000 });
    expect(host.calls("resolve")[1]).toMatchObject({ documentEpoch: 1 });
    expect(screen.queryAllByText("Page reloaded — select it again")).toHaveLength(0);
    expect(screen.queryByRole("region", { name: "Selected element" })).not.toBeNull();
  });

  it("doesn't take a recycled id for the same node after a reload", async () => {
    await mountSelected();
    // The new document numbers its elements afresh, so "el-1" is now whatever
    // it counted first — here a button among two, not three.
    host.picker.reselect.mockImplementation(async () => {
      const found = svelteObservation({
        frameworkEvidence: [
          { ...svelteObservation().frameworkEvidence[0]!, sameLocCount: 2 } as never,
        ],
      });
      setTimeout(() => host.select(1, [found], "reselect"), 0);
      return true;
    });
    await act(async () => host.documentReady(1));
    await screen.findAllByText("Page reloaded — select it again", {}, { timeout: 4000 });
    // And the page was not asked for it by that id in the first place.
    expect(host.picker.reselect.mock.calls[0]![0]).not.toHaveProperty("elementId");
    expect(host.calls("resolve")).toHaveLength(1);
  });

  it("says the page reloaded when the new page can't vouch for the selection", async () => {
    await mountSelected();
    host.picker.reselect.mockImplementation(async () => {
      setTimeout(() => host.select(1, [svelteObservation({ tagName: "SPAN" })], "reselect"), 0);
      return true;
    });
    await act(async () => host.documentReady(1));
    await screen.findAllByText("Page reloaded — select it again", {}, { timeout: 4000 });
    expect(host.calls("resolve")).toHaveLength(1);
  });

  it("says the file changed while browsing, and asks the page once selecting again", async () => {
    await mountSelected();
    fireEvent.click(screen.getByRole("radio", { name: "Browse" }));
    await waitFor(() => expect(host.preview.setMode).toHaveBeenCalled());
    await act(async () => host.sourceChanged(FILE));
    // The page answers only in Inspect mode, so this one is the user's to see.
    await screen.findAllByText("File changed — select it again");
    await pause(HMR_SETTLE_MS + PAST_REATTACH_MS);
    expect(host.picker.reselect).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("radio", { name: "Inspect" }));
    await waitFor(() => expect(host.calls("resolve")).toHaveLength(2), { timeout: 4000 });
    await waitFor(() =>
      expect(screen.queryAllByText("File changed — select it again")).toHaveLength(0)
    );
  });

  it("stops asking, and says so, when the page never finds the element", async () => {
    host.reselectFinds = false;
    await mountSelected();
    vi.useFakeTimers();
    await act(async () => host.sourceChanged(FILE));
    await elapse(HMR_SETTLE_MS * 10);
    expect(screen.getAllByText("File changed — select it again").length).toBeGreaterThan(0);
    // Bounded: one ask per settle window, then the selection is the user's.
    expect(host.picker.reselect).toHaveBeenCalledTimes(6);
    await elapse(HMR_SETTLE_MS * 10);
    expect(host.picker.reselect).toHaveBeenCalledTimes(6);
  });

  it("goes stale, and says so, when the page answers with a different element", async () => {
    await mountSelected();
    host.picker.reselect.mockImplementationOnce(async () => {
      setTimeout(() => host.select(0, [svelteObservation({ tagName: "SPAN" })], "reselect"), 0);
      return true;
    });
    await act(async () => host.sourceChanged(FILE));
    await screen.findAllByText("File changed — select it again", {}, { timeout: 4000 });
    // Never resolved: what now sits at that location is not what was selected.
    expect(host.calls("resolve")).toHaveLength(1);
    expect(host.preview.clearSelection).toHaveBeenCalled();
  });

  it("asks for an element the page dropped before giving the selection up", async () => {
    await mountSelected();
    // A hot update replaces the node; the page reports its selection empty.
    await act(async () => host.select(0, [], "document"));
    expect(screen.queryByRole("region", { name: "Selected element" })).not.toBeNull();
    await waitFor(() => expect(host.calls("resolve")).toHaveLength(2), { timeout: 4000 });
    expect(screen.queryByRole("region", { name: "Selected element" })).not.toBeNull();
  });

  it("lets a selection go when the element just left a page nothing was edited on", async () => {
    host.reselectFinds = false;
    await mountSelected();
    vi.useFakeTimers();
    await act(async () => host.select(0, [], "document"));
    await elapse(HMR_SETTLE_MS * 8);
    expect(session().getSnapshot().selection.status).toBe("none");
    expect(screen.queryByRole("region", { name: "Selected element" })).toBeNull();
  });

  it("tells the page when the pointer has left it for the host, once per hover", async () => {
    await mountSelected();
    // Nothing hovered on the page: moving around the host is nobody's business.
    fireEvent.pointerMove(document.body);
    expect(host.preview.clearHover).not.toHaveBeenCalled();

    await act(async () => host.hover(svelteObservation()));
    fireEvent.pointerMove(document.body);
    fireEvent.pointerMove(document.body);
    expect(host.preview.clearHover).toHaveBeenCalledTimes(1);
    expect(host.preview.clearHover).toHaveBeenCalledWith({ sessionId: "session-1" });

    // The page saw the pointer leave by itself: there is nothing left to tell it.
    await act(async () => host.hover(svelteObservation()));
    await act(async () => host.hover(null));
    fireEvent.pointerMove(document.body);
    expect(host.preview.clearHover).toHaveBeenCalledTimes(1);
    // A hover is labelled from what the page said; nothing is resolved for it.
    expect(host.calls("resolve")).toHaveLength(1);
  });

  it("clears the selection, here and on the page, from the strip", async () => {
    await mountSelected();
    fireEvent.click(screen.getByRole("button", { name: "Deselect" }));
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Selected element" })).toBeNull()
    );
    expect(host.preview.clearSelection).toHaveBeenCalledWith({ sessionId: "session-1" });
  });

  it("keys on the event's epoch when documentReady beats epoch-advanced", async () => {
    await mountSelected();
    // The reinstalled runtime reports the new document before the bridge's push.
    await act(async () => host.documentReady(1));
    // The new page is asked for the selection, and answers for its own epoch.
    await waitFor(() => expect(host.calls("resolve")).toHaveLength(2), { timeout: 4000 });
    expect(host.calls("resolve")[1]).toMatchObject({ documentEpoch: 1 });
    await waitFor(() =>
      expect(screen.queryAllByText("Page changed — select it again")).toHaveLength(0)
    );
    await waitFor(() =>
      expect(screen.queryAllByText("Page reloaded — select it again")).toHaveLength(0)
    );

    // The late push for the epoch we are already in must not invalidate anything.
    await act(async () => host.epochAdvanced(1));
    expect(screen.queryAllByText("Page changed — select it again")).toHaveLength(0);
    expect(screen.queryAllByText("Page reloaded — select it again")).toHaveLength(0);
  });

  it("drops a resolve when the owning file changed while it was out", async () => {
    let finish: () => void = () => {};
    host.picker.resolve.mockImplementation(
      (request) =>
        new Promise((resolve) => {
          finish = () => resolve(host.answerResolve(request));
        })
    );
    await mountBound();
    await act(async () => host.select(0));
    await waitFor(() => expect(host.calls("resolve")).toHaveLength(1));
    await act(async () => host.sourceChanged(FILE));
    await act(async () => finish());
    // The answer paired old markup with new bytes, so it is thrown away — and
    // the click asked for again rather than handed back.
    await screen.findAllByText("Waiting for the preview to update");
    expect(screen.queryByRole("region", { name: "Selected element" })).toBeNull();
    await waitFor(() => expect(host.calls("resolve")).toHaveLength(2), { timeout: 4000 });
    await act(async () => finish());
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Selected element" })).not.toBeNull()
    );
  });

  it("takes a newer epoch from a mode switch", async () => {
    await mountSelected();
    host.preview.setMode.mockImplementationOnce(async ({ mode }) => ({
      sessionId: "session-1",
      panelId: "preview-1",
      projectId: "p1",
      documentEpoch: 1,
      mode,
      guestReady: false,
      droppedMessages: 0,
      suspended: false,
    }));
    fireEvent.click(screen.getByRole("radio", { name: "Browse" }));
    await screen.findAllByText("Page reloaded — select it again");
  });

  it("holds a click on a file that changed moments ago until HMR can land, then resolves it", async () => {
    await mountBound();
    const start = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(start);
    await act(async () => host.sourceChanged(FILE));
    clock.mockReturnValue(start + 400);
    await act(async () => host.select(0));
    // The host's answer pairs the click with bytes the page may not show yet,
    // so it is kept back rather than put on screen.
    await screen.findAllByText("Waiting for the preview to update");
    expect(screen.queryByRole("textbox", { name: "Request for the agent" })).toBeNull();
    expect(host.calls("resolve")).toHaveLength(1);

    // No second click: the first is asked for again once the window has passed.
    clock.mockReturnValue(start + 1500);
    await screen.findByRole("textbox", { name: "Request for the agent" }, { timeout: 4000 });
    expect(host.calls("resolve")).toHaveLength(2);
  });

  it("drops a resolve that finishes after the document moved on", async () => {
    let finish: () => void = () => {};
    host.picker.resolve.mockImplementation(
      (request) =>
        new Promise((resolve) => {
          finish = () => resolve(host.answerResolve(request));
        })
    );
    await mountBound();
    await act(async () => host.select(0));
    await waitFor(() => expect(host.calls("resolve")).toHaveLength(1));
    await act(async () => host.epochAdvanced(1));
    await act(async () => finish());
    await screen.findAllByText("Page changed — select it again");
    expect(screen.queryByRole("region", { name: "Selected element" })).toBeNull();
  });
});

describe("lifetime", () => {
  it("reopens the workspace when the host reports it closed", async () => {
    await mountSelected();
    host.openWith = () => ({
      status: "ready",
      workspaceId: "ws-2",
      appPath: ".",
      appPaths: ["."],
      scanComplete: true,
    });
    host.picker.resolve.mockImplementationOnce(async () => {
      throw workspaceClosedError();
    });
    await act(async () => host.select(0));
    await waitFor(() => expect(host.calls("openWorkspace")).toHaveLength(2));
    expect(screen.queryByRole("region", { name: "Selected element" })).toBeNull();

    await act(async () => host.select(0));
    await screen.findByRole("textbox", { name: "Request for the agent" });
    expect(host.calls("resolve").at(-1)).toMatchObject({ workspaceId: "ws-2" });
  });

  it("reports a workspace it couldn't reopen rather than trying again and again", async () => {
    await mountSelected();
    host.openWith = () => {
      throw new Error("EACCES: permission denied, open '/repo'");
    };
    host.picker.resolve.mockImplementation(async () => {
      throw workspaceClosedError();
    });
    await act(async () => host.select(0));
    await screen.findByText(/EACCES/);
    expect(host.calls("openWorkspace")).toHaveLength(2);
    expect(screen.getByRole("alert").textContent).toContain("Couldn't read the site source");
  });

  it("keeps working with no plugin loaded, and with the plugins that used to own it switched off", async () => {
    // The picker is the dev preview's own: nothing registers it, and a plugin
    // that once carried a picker going away takes nothing with it.
    usePluginRuntimeStore.setState({
      pluginMetaById: new Map([
        ["daintree.sveltekit-builder", { devMode: false, displayName: "SvelteKit Builder" }],
      ]),
      disabledPluginIds: new Set(["daintree.sveltekit-builder"]),
    } as never);
    await mountSelected();
    expect(useDevPreviewToolStore.getState().activeByPanel["preview-1"]).toBe(
      ELEMENT_PICKER_TOOL_ID
    );
    await act(async () =>
      usePluginRuntimeStore.setState({ disabledPluginIds: new Set() } as never)
    );
    await act(async () =>
      usePluginRuntimeStore.setState({
        disabledPluginIds: new Set(["daintree.sveltekit-builder"]),
      } as never)
    );
    expect(host.preview.detach).not.toHaveBeenCalled();
    expect(screen.getByRole("region", { name: "Selected element" })).toBeTruthy();
  });

  it("tears down when switched off and starts fresh when switched on again", async () => {
    mount();
    await waitFor(() => expect(host.picker.bind).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(host.calls("openWorkspace")).toHaveLength(1));

    await switchOff();
    expect(host.preview.detach).toHaveBeenCalledWith({ sessionId: "session-1" });
    expect(host.calls("closeWorkspace")).toEqual([{ workspaceId: "ws-1" }]);
    expect(host.listenerCounts()).toEqual({ event: 0, source: 0 });
    await act(async () => {});
    expect(host.picker.bind).toHaveBeenCalledTimes(1);
    expect(host.calls("openWorkspace")).toHaveLength(1);

    host.openWith = () => ({
      status: "ready",
      workspaceId: "ws-2",
      appPath: ".",
      appPaths: ["."],
      scanComplete: true,
    });
    // A session that knows nothing of the closed one.
    await act(async () => switchOn());
    await waitFor(() => expect(host.picker.bind).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(host.calls("openWorkspace")).toHaveLength(2));
    await screen.findByRole("radio", { name: "Browse" });
    await act(async () => host.documentReady(0));
    await act(async () => host.select(0));
    await screen.findByRole("textbox", { name: "Request for the agent" });
    expect(host.calls("resolve").at(-1)).toMatchObject({ workspaceId: "ws-2" });
  });

  it("keeps the binding across a remount", async () => {
    await mountSelected();
    cleanup();
    // A tick later, not right away: a release deferred to a timer would pass
    // an immediate check and still detach before the remount.
    await pause(ONE_TICK_MS);
    expect(host.preview.detach).not.toHaveBeenCalled();
    mount();
    expect(screen.getByRole("region", { name: "Selected element" })).toBeTruthy();
    expect(host.picker.bind).toHaveBeenCalledTimes(1);
  });

  it("releases the preview and workspace once the picker is switched off", async () => {
    await mountSelected();
    cleanup();
    await switchOff();
    expect(host.preview.detach).toHaveBeenCalledWith({ sessionId: "session-1" });
    expect(host.calls("closeWorkspace")).toEqual([{ workspaceId: "ws-1" }]);
  });

  it("disconnects the preview when the panel moves to another worktree", async () => {
    await mountSelected();
    cleanup();
    context.current = { projectId: "p1", worktreeId: "wt-2", worktreePath: "/repo-2" };
    await act(async () => publishDevPreviewToolContext(hostContext()));
    mount();
    await waitFor(() =>
      expect(host.preview.detach).toHaveBeenCalledWith({ sessionId: "session-1" })
    );
    await waitFor(() =>
      expect(host.calls("openWorkspace").at(-1)).toMatchObject({ worktreeId: "wt-2" })
    );
    expect(host.calls("closeWorkspace")).toContainEqual({ workspaceId: "ws-1" });
    expect(screen.queryByRole("region", { name: "Selected element" })).toBeNull();
  });
});

describe("preview reattach", () => {
  it("reattaches on its own when the grid recreates the preview's page", async () => {
    await mountBound();
    expect(host.picker.bind).toHaveBeenCalledTimes(1);

    await act(async () =>
      host.pushPreview({
        kind: "detached",
        sessionId: "session-1",
        projectId: "p1",
        reason: "debugger-detached",
      })
    );

    await waitFor(() => expect(host.picker.bind).toHaveBeenCalledTimes(2), { timeout: 2000 });
    await screen.findByRole("radio", { name: "Browse" });
  });

  it("says it paused while the preview shows a page outside the local dev server, and picks up again", async () => {
    await mountBound();

    await act(async () =>
      host.pushPreview({
        kind: "origin-policy",
        sessionId: "session-1",
        projectId: "p1",
        documentEpoch: 1,
        suspended: true,
      })
    );
    await screen.findAllByText("Paused — this page isn't at a local address");
    // An observation, not a fault: the binding is intact, so nothing to click
    // and no reconnect attempt of the controller's own.
    expect(screen.queryByRole("button", { name: "Reconnect" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(host.picker.bind).toHaveBeenCalledTimes(1);

    await act(async () =>
      host.pushPreview({
        kind: "origin-policy",
        sessionId: "session-1",
        projectId: "p1",
        documentEpoch: 2,
        suspended: false,
      })
    );
    await waitFor(() =>
      expect(screen.queryAllByText("Paused — this page isn't at a local address")).toHaveLength(0)
    );
    expect(host.picker.bind).toHaveBeenCalledTimes(1);
  });

  it("stays disconnected when the user asked to disconnect", async () => {
    await mountBound();

    await act(async () =>
      host.pushPreview({
        kind: "detached",
        sessionId: "session-1",
        projectId: "p1",
        reason: "requested",
      })
    );
    await pause(PAST_REATTACH_MS);
    expect(host.picker.bind).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeTruthy();
  });

  it("ignores pushes for a binding that isn't its own", async () => {
    await mountBound();
    await act(async () =>
      host.pushPreview({
        kind: "detached",
        sessionId: "session-other",
        projectId: "p1",
        reason: "requested",
      })
    );
    await act(async () => host.documentReady(0, "session-other"));
    expect(session().getSnapshot().binding.status).toBe("bound");
    expect(screen.queryByRole("button", { name: "Reconnect" })).toBeNull();
  });
});

describe("picker lifetime while switched on", () => {
  function boundState(request: { panelId: string; mode?: "browse" | "select" }) {
    return {
      sessionId: "session-1",
      panelId: request.panelId,
      projectId: "p1",
      documentEpoch: 0,
      mode: request.mode ?? ("select" as const),
      guestReady: false,
      droppedMessages: 0,
      suspended: false,
    };
  }

  it("connects promptly once the page is up, however long it waited for the server", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // The bind that answers the page coming up loses a race with the page
    // registering itself; the one after it succeeds.
    let failuresLeft = Infinity;
    host.picker.bind.mockImplementation(async (request) => {
      if (failuresLeft > 0) {
        failuresLeft--;
        throw new Error("No dev preview is available on that panel");
      }
      return boundState(request);
    });
    startDevPreviewToolSessions();
    publishDevPreviewToolContext({ ...hostContext(), isWebviewReady: false });
    useDevPreviewToolStore.getState().setActive("preview-1", ELEMENT_PICKER_TOOL_ID);
    render(<PickerHarness />, { wrapper: TooltipProvider });
    await screen.findByText("Connecting to the page");
    // A cold dev server: long enough for the backoff to reach its long steps.
    await elapse(40_000);

    // Inside the first step of a fresh round, and well short of the step a
    // capped delay alone would wait.
    failuresLeft = 1;
    await act(async () => {
      publishDevPreviewToolContext(hostContext());
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(screen.queryByText("Connecting to the page")).toBeNull();
    expect(session().getSnapshot().binding.status).toBe("bound");
  });

  it("never waits out a long backoff step beside a page that is showing", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // Six failures with the page up throughout: the uncapped schedule would
    // still be half a minute from its next attempt.
    let failuresLeft = 6;
    host.picker.bind.mockImplementation(async (request) => {
      if (failuresLeft > 0) {
        failuresLeft--;
        throw new Error("No dev preview is available on that panel");
      }
      return boundState(request);
    });
    mount();
    await screen.findByText("Connecting to the page");
    await elapse(12_000);
    expect(session().getSnapshot().binding.status).toBe("bound");
  });

  it("keeps trying when the page arrives under the last attempt it had left", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let pageUp = false;
    let release: (() => void) | null = null;
    host.picker.bind.mockImplementation(async (request) => {
      if (release === null && pageUp) {
        // The attempt in flight as the page arrives.
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        throw new Error("No dev preview is available on that panel");
      }
      if (release === null) throw new Error("No dev preview is available on that panel");
      return boundState(request);
    });
    startDevPreviewToolSessions();
    publishDevPreviewToolContext({ ...hostContext(), isWebviewReady: false });
    useDevPreviewToolStore.getState().setActive("preview-1", ELEMENT_PICKER_TOOL_ID);
    render(<PickerHarness />, { wrapper: TooltipProvider });
    await screen.findByText("Connecting to the page");
    // Through every step but the last, whose attempt is the one held open.
    await elapse(61_000);
    pageUp = true;
    await elapse(60_000);
    expect(release).not.toBeNull();

    await act(async () => {
      publishDevPreviewToolContext(hostContext());
      (release as (() => void) | null)?.();
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(session().getSnapshot().binding.status).toBe("bound");
  });

  it("says it couldn't connect, and why, once it has stopped trying", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    host.picker.bind.mockImplementation(async () => {
      throw new Error("The preview's page refused the runtime");
    });
    mount();
    await screen.findByText("Connecting to the page");
    await elapse(10 * 60_000);
    await screen.findAllByText("Couldn't connect to the page");
    expect(text()).not.toContain("refused the runtime");
    const details = screen.getByRole("button", { name: "Details" });
    act(() => details.focus());
    await waitFor(() => expect(text()).toContain("The preview's page refused the runtime"));
  });
});

/** The panel store the composer needs: the preview, and optionally an agent beside it. */
function panels(withTerminal: boolean) {
  usePanelStore.setState({
    panelIds: withTerminal ? ["preview-1", "term-1"] : ["preview-1"],
    panelsById: {
      "preview-1": { id: "preview-1", kind: "dev-preview", location: "grid", worktreeId: "wt-1" },
      ...(withTerminal
        ? {
            "term-1": {
              id: "term-1",
              kind: "terminal",
              location: "grid",
              worktreeId: "wt-1",
              hasPty: true,
              title: "claude · pricing polish",
              launchAgentId: "claude",
              detectedAgentId: "claude",
              // Unclassified: the host has no evidence the agent can take input.
              agentState: null,
            },
          }
        : {}),
    } as never,
  });
}

/**
 * The host actions a delivery goes through, with readiness withheld until the
 * test says otherwise and every submission recorded.
 */
async function agentActions(options: { onSend?: () => Promise<void> } = {}) {
  const { actionService } = await import("@/services/ActionService");
  const sent: string[] = [];
  const launches: string[] = [];
  let ready = false;
  const dispatch = vi.spyOn(actionService, "dispatch").mockImplementation((async (
    id: string,
    args: Record<string, unknown>
  ) => {
    switch (id) {
      case "agent.launch":
        launches.push(String(args.agentId));
        return { ok: true, result: { launched: true, terminalId: "term-9" } };
      case "terminal.getStatus":
        return {
          ok: true,
          result: {
            terminals: [
              {
                terminalId: (args.terminalIds as string[])[0],
                agentId: "claude",
                spawnedAt: 1_000,
                agentIncarnation: 0,
                agentState: ready ? "waiting" : null,
                ...(args.submissionToken ? { submission: { phase: "pty_written" } } : {}),
              },
            ],
          },
        };
      case "terminal.sendCommand":
        await options.onSend?.();
        sent.push(String(args.command));
        return { ok: true, result: { submissionToken: `token-${sent.length}` } };
      default:
        return { ok: false, error: { message: `unexpected ${id}` } };
    }
  }) as never);
  return {
    dispatch,
    sent,
    launches,
    polls: () => dispatch.mock.calls.filter(([id]) => id === "terminal.getStatus").length,
    becomeReady: () => (ready = true),
  };
}

async function typeAndSend() {
  const request = screen.getByRole("textbox", { name: "Request for the agent" });
  fireEvent.change(request, { target: { value: "Say Upgrade" } });
  const send = () => screen.getByRole("button", { name: SEND_NAME }) as HTMLButtonElement;
  await waitFor(() => expect(isOff(send())).toBe(false));
  fireEvent.click(send());
}

describe("delivery across the picker's lifetime", () => {
  it("still delivers a request when its agent becomes ready after the picker is switched off", async () => {
    // Closing the picker puts it away. A request Send already accepted is still
    // on its way, and the source it cites stays open to be checked against
    // until it has gone in.
    panels(true);
    const agent = await agentActions();
    await mountSelected();
    await typeAndSend();
    await waitFor(() => expect(agent.polls()).toBeGreaterThan(1));

    cleanup();
    await switchOff();
    expect(host.calls("closeWorkspace")).toEqual([]);
    agent.becomeReady();

    await waitFor(() => expect(agent.sent).toHaveLength(1), { timeout: 4_000 });
    expect(agent.sent[0]).toContain("Say Upgrade");
    await waitFor(() => expect(host.calls("closeWorkspace")).toEqual([{ workspaceId: "ws-1" }]));
    expect(readComposerMemory(composerMemoryKey("preview-1", "wt-1")).deliveries).toEqual([
      expect.objectContaining({ instruction: "Say Upgrade", state: { status: "sent" } }),
    ]);
  });

  it("brings back the draft and a waiting request when the picker is opened again", async () => {
    panels(true);
    const agent = await agentActions();
    await mountSelected();
    await typeAndSend();
    await waitFor(() => expect(agent.polls()).toBeGreaterThan(1));
    const request = screen.getByRole("textbox", { name: "Request for the agent" });
    fireEvent.change(request, { target: { value: "And make it bold" } });

    cleanup();
    await switchOff();
    // The next session gets a workspace of its own, as the host hands out.
    host.openWith = () => ({
      status: "ready",
      workspaceId: "ws-2",
      appPath: ".",
      appPaths: ["."],
      scanComplete: true,
    });
    mount();
    await waitFor(() => expect(host.calls("openWorkspace")).toHaveLength(2));
    await screen.findByRole("radio", { name: "Browse" });
    await act(async () => host.documentReady(0));

    const reopened = (await screen.findByRole("textbox", {
      name: "Request for the agent",
    })) as HTMLTextAreaElement;
    expect(reopened.value).toBe("And make it bold");
    expect(readComposerMemory(composerMemoryKey("preview-1", "wt-1")).deliveries).toEqual([
      expect.objectContaining({ instruction: "Say Upgrade", state: { status: "queued" } }),
    ]);

    // Still about what it was written about, and sendable through the new session.
    const send = () => screen.getByRole("button", { name: SEND_NAME }) as HTMLButtonElement;
    await waitFor(() => expect(isOff(send())).toBe(false));
    fireEvent.click(send());
    agent.becomeReady();

    await waitFor(() => expect(agent.sent).toHaveLength(2), { timeout: 8_000 });
    expect(agent.sent[0]).toContain("Say Upgrade");
    expect(agent.sent[1]).toContain("And make it bold");
    // The closed session waited for its own request, then let its workspace go.
    await waitFor(() => expect(host.calls("closeWorkspace")).toEqual([{ workspaceId: "ws-1" }]));
  });

  it("lets an idle reopened session go at once, and tells its picks from the restored pin", async () => {
    panels(true);
    const agent = await agentActions();
    await mountSelected();
    await typeAndSend();
    fireEvent.change(screen.getByRole("textbox", { name: "Request for the agent" }), {
      target: { value: "And make it bold" },
    });
    cleanup();
    await switchOff();
    host.openWith = () => ({
      status: "ready",
      workspaceId: "ws-2",
      appPath: ".",
      appPaths: ["."],
      scanComplete: true,
    });
    mount();
    await screen.findByRole("radio", { name: "Browse" });
    await act(async () => host.documentReady(0));
    await act(async () => host.select(0));
    // Same element, same epoch, new session: not the selection the draft was pinned to.
    await screen.findByRole("button", { name: /^Switch to / });

    cleanup();
    await switchOff();
    expect(host.calls("closeWorkspace")).toEqual([{ workspaceId: "ws-2" }]);
    expect(agent.sent).toEqual([]);
  });

  it("won't send a restored draft whose source changed while the picker was closed", async () => {
    panels(true);
    const agent = await agentActions();
    await mountSelected();
    const request = screen.getByRole("textbox", { name: "Request for the agent" });
    fireEvent.change(request, { target: { value: "Say Upgrade" } });

    cleanup();
    await switchOff();
    host.diskRevisions.set(FILE, sha("edited while closed"));
    host.openWith = () => ({
      status: "ready",
      workspaceId: "ws-2",
      appPath: ".",
      appPaths: ["."],
      scanComplete: true,
    });
    mount();
    await waitFor(() => expect(host.calls("openWorkspace")).toHaveLength(2));
    agent.becomeReady();
    const send = () => screen.getByRole("button", { name: SEND_NAME }) as HTMLButtonElement;
    await waitFor(() => expect(isOff(send())).toBe(false));
    fireEvent.click(send());

    await waitFor(() =>
      expect(readComposerMemory(composerMemoryKey("preview-1", "wt-1")).deliveries).toEqual([
        expect.objectContaining({
          instruction: "Say Upgrade",
          state: expect.objectContaining({ status: "failed" }),
        }),
      ])
    );
    expect(agent.sent).toEqual([]);
  });

  it("types nothing into the agent when the preview is trashed during the readiness wait", async () => {
    // The request is waiting on an agent that has shown no sign it can take
    // input. The preview going away has to stop the run itself — and a session
    // that reaches its prompt afterwards must not be typed into.
    panels(true);
    const agent = await agentActions();
    await mountSelected();
    await typeAndSend();
    await waitFor(() => expect(agent.polls()).toBeGreaterThan(1));

    cleanup();
    await act(async () =>
      usePanelStore.setState((state) => ({
        panelsById: {
          ...state.panelsById,
          "preview-1": { ...state.panelsById["preview-1"]!, location: "trash" },
        } as never,
      }))
    );
    const pollsAtTrash = agent.polls();
    await pause(QUIET_WINDOW_MS);
    agent.becomeReady();
    await pause(QUIET_WINDOW_MS);

    expect(agent.sent).toEqual([]);
    // And the run really stopped, rather than quietly polling on.
    expect(agent.polls()).toBe(pollsAtTrash);
    expect(readComposerMemory(composerMemoryKey("preview-1", "wt-1")).deliveries).toEqual([]);
    await waitFor(() => expect(host.calls("closeWorkspace")).toEqual([{ workspaceId: "ws-1" }]));
  });

  it("doesn't retry a request the picker was switched off in the middle of writing", async () => {
    // Part of the prompt may already be in the agent's input. Cancelling can't
    // take that back, so the one thing that must not happen is a second write.
    panels(true);
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const agent = await agentActions({ onSend: () => held });
    await mountSelected();
    await typeAndSend();
    agent.becomeReady();
    await waitFor(() =>
      expect(agent.dispatch.mock.calls.some(([id]) => id === "terminal.sendCommand")).toBe(true)
    );

    cleanup();
    await switchOff();
    await act(async () => {
      release();
      await new Promise((resolve) => setTimeout(resolve, QUIET_WINDOW_MS));
    });
    expect(agent.sent).toHaveLength(1);
    expect(agent.sent[0]).toContain("Say Upgrade");
    expect(agent.dispatch.mock.calls.filter(([id]) => id === "terminal.sendCommand")).toHaveLength(
      1
    );
  });

  it("launches once and sends once across a remount, and shows the receipt after it", async () => {
    // Starting an agent re-lays the grid, which remounts the picker — the
    // remount used to cancel the very request that caused it. The run lives
    // with the host, so it survives, and the surface picks the receipt back up.
    panels(false);
    const agent = await agentActions();
    await mountSelected();
    await typeAndSend();
    await waitFor(() => expect(agent.launches).toEqual(["claude"]));

    cleanup();
    await pause(ONE_TICK_MS);
    mount();
    agent.becomeReady();

    await waitFor(() => expect(agent.sent).toHaveLength(1), { timeout: 4_000 });
    expect(agent.sent[0]).toContain("Say Upgrade");
    expect(agent.launches).toEqual(["claude"]);
    await within(await screen.findByRole("list", { name: "Requests" })).findByText(/^Sent to /);
  });
});

describe("a request waiting its turn", () => {
  /** An agent's edit to the page's file: what disk holds now, and what the host reads from it. */
  const EDITED = sha("an agent's edit");

  function editPageFile() {
    host.diskRevisions.set(FILE, EDITED);
    host.resultsFor = () => svelteResults(EDITED);
    return act(async () => host.sourceChanged(FILE, EDITED));
  }

  it("goes out about the selection proved again after an edit, once it has been", async () => {
    // The request ahead of it usually edits the very file this one is about.
    // Held to the selection it was made about, it would cite bytes that are
    // gone and fail; it follows the proof instead — and waits for it.
    panels(true);
    let supersededAtSend: number | undefined;
    const agent = await agentActions({
      onSend: async () => {
        const state = session().getSnapshot().selection;
        supersededAtSend = state.status === "ready" ? (state.supersedes?.length ?? 0) : -1;
      },
    });
    await mountSelected();
    await typeAndSend();
    await waitFor(() => expect(agent.polls()).toBeGreaterThan(0));

    await editPageFile();
    // At its prompt while the page is still being asked: not a reason to go early.
    agent.becomeReady();
    await waitFor(() => expect(agent.sent).toHaveLength(1), { timeout: 6_000 });
    expect(supersededAtSend).toBe(1);
    expect(agent.sent[0]).toContain("Say Upgrade");
    expect(agent.sent[0]).toContain(`written at ${FILE}:6:3`);
    expect(text()).not.toContain("The source changed since you picked this");
  });

  it("stays about the selection it was made about when the user has picked something else since", async () => {
    panels(true);
    const agent = await agentActions();
    await mountSelected();
    await typeAndSend();
    await waitFor(() => expect(agent.polls()).toBeGreaterThan(0));

    await act(async () =>
      host.select(0, [
        svelteObservation({ elementId: "el-2", tagName: "A", label: 'a "Pricing FAQ"' }),
      ])
    );
    await waitFor(() => expect(host.calls("resolve")).toHaveLength(2));
    agent.becomeReady();
    await waitFor(() => expect(agent.sent).toHaveLength(1), { timeout: 4_000 });
    expect(agent.sent[0]).toContain("Start Pro");
    expect(agent.sent[0]).not.toContain("Pricing FAQ");
  });

  it("fails honestly when its source changed and the page couldn't vouch for the selection again", async () => {
    panels(true);
    const agent = await agentActions();
    await mountSelected();
    await typeAndSend();
    await waitFor(() => expect(agent.polls()).toBeGreaterThan(0));

    // Something else now sits where the element was written.
    host.picker.reselect.mockImplementationOnce(async () => {
      setTimeout(() => host.select(0, [svelteObservation({ tagName: "SPAN" })], "reselect"), 0);
      return true;
    });
    await editPageFile();
    agent.becomeReady();
    await screen.findByText(/The source changed since you picked this/, {}, { timeout: 6_000 });
    expect(agent.sent).toEqual([]);
  });
});

describe("issue recovery", () => {
  /** The strip's own notice slot, so a drawer assertion can't read the wrong one. */
  function notice(): HTMLElement {
    return screen.getByRole("alert");
  }

  it("offers the mode change that failed again, and asks for the mode that failed", async () => {
    await mountBound();
    host.preview.setMode.mockRejectedValueOnce(new Error("the page went away"));
    fireEvent.click(screen.getByRole("radio", { name: "Browse" }));

    await waitFor(() => expect(notice().textContent).toContain("the page went away"));
    expect(within(notice()).queryByRole("button", { name: "Dismiss" })).not.toBeNull();
    const retry = within(notice()).getByRole("button", { name: "Retry" });
    // Inspect is still what the preview is on: the failure rolled the mode back.
    expect(screen.getByRole("radio", { name: "Inspect" }).getAttribute("aria-checked")).toBe(
      "true"
    );

    host.preview.setMode.mockClear();
    fireEvent.click(retry);
    // The target it asks for again is the one that failed, not the mode the
    // rollback left the preview on.
    await waitFor(() =>
      expect(host.preview.setMode).toHaveBeenCalledWith({ sessionId: "session-1", mode: "browse" })
    );
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: "Browse" }).getAttribute("aria-checked")).toBe(
        "true"
      )
    );
  });

  it("offers to rebuild the session when the fault is inside the page", async () => {
    await mountBound();
    await act(async () => host.runtimeIssue("internal"));

    await waitFor(() => expect(notice().textContent).toContain("inside the page"));
    host.picker.bind.mockClear();
    fireEvent.click(within(notice()).getByRole("button", { name: "Reconnect" }));
    await waitFor(() => expect(host.picker.bind).toHaveBeenCalled());
  });

  it("does not offer to rebuild the session over a limit rebuilding cannot lift", async () => {
    // Reconnecting stales and then clears the selection. Offering it for a
    // truncation would cost the user their pick and leave the limit in place.
    await mountSelected();
    await act(async () => host.runtimeIssue("capacity", { detail: "capped at 24 nodes" }));

    await waitFor(() => expect(text()).toContain("Outer components were left out"));
    // The guest's own words are a log line, not copy: the headline says which
    // limit in the product's terms.
    expect(text()).not.toContain("capped at 24 nodes");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: "Reconnect" })).toBeNull();
    // And the selection it was about is still there.
    expect(screen.queryByRole("region", { name: "Selected element" })).not.toBeNull();
  });

  it("lets a warning be acknowledged without pretending anything can repair it", async () => {
    await mountBound();
    await act(async () => host.runtimeIssue("metadata-unavailable", { framework: "svelte" }));

    await waitFor(() => expect(text()).toContain("No Svelte source locations"));
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reconnect" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(text()).not.toContain("No Svelte source locations"));
  });
});

describe("details disclosure", () => {
  function toggle(): HTMLElement {
    return screen.getByRole("button", { name: "Element Picker details" });
  }

  it("names the thing it discloses and carries the state on aria-expanded", async () => {
    await mountBound();
    // Nothing to show yet: the drawer keeps itself shut, so the control must
    // not claim it is open.
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(toggle().hasAttribute("aria-pressed")).toBe(false);
    expect(toggle().hasAttribute("title")).toBe(false);

    await act(async () => host.select(0));
    await screen.findByRole("region", { name: "Selected element" });
    await waitFor(() => expect(toggle().getAttribute("aria-expanded")).toBe("true"));

    fireEvent.click(toggle());
    await waitFor(() => expect(toggle().getAttribute("aria-expanded")).toBe("false"));
    // The name held still across both flips; only the state moved.
    expect(toggle().getAttribute("aria-label")).toBe("Element Picker details");
    fireEvent.focus(toggle());
    expect((await screen.findByRole("tooltip")).textContent).toContain("Element Picker details");
    expect(screen.queryByRole("region", { name: "Selected element" })).toBeNull();
  });
});

describe("resolving skeleton", () => {
  const GATE_MS = 400;
  const FLOOR_MS = 250;
  const SKELETON = "Finding the source for this element";

  /** Hold the host's answer so the gate and the floor can be driven by hand. */
  function holdResolve(): () => void {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    host.picker.resolve.mockImplementation(async (request) => {
      await held;
      return host.answerResolve(request);
    });
    return release;
  }

  function skeleton(): HTMLElement | null {
    return screen.queryByRole("status", { name: SKELETON });
  }

  it("shows no skeleton at all for an answer that beats the gate", async () => {
    await mountBound();
    const release = holdResolve();
    vi.useFakeTimers();

    await act(async () => host.select(0));
    await elapse(GATE_MS - 1);
    expect(skeleton()).toBeNull();

    release();
    await elapse(0);
    // Ready, on screen, and never a skeleton: the floor has nothing to hold
    // because the gate never let anything through.
    expect(screen.queryByRole("region", { name: "Selected element" })).not.toBeNull();
    expect(skeleton()).toBeNull();
    await elapse(GATE_MS + FLOOR_MS);
    expect(skeleton()).toBeNull();
    expect(screen.queryByRole("region", { name: "Selected element" })).not.toBeNull();
  });

  it("holds a skeleton that appeared for its display floor instead of flashing it", async () => {
    await mountBound();
    const release = holdResolve();
    vi.useFakeTimers();

    await act(async () => host.select(0));
    await elapse(GATE_MS);
    expect(skeleton()).not.toBeNull();

    // The answer lands a frame past the gate — the exact case the floor exists
    // for. The identity waits; the skeleton does not tear down under it.
    release();
    await elapse(10);
    expect(skeleton()).not.toBeNull();
    expect(screen.queryByRole("region", { name: "Selected element" })).toBeNull();

    await elapse(FLOOR_MS - 11);
    expect(skeleton()).not.toBeNull();

    await elapse(1);
    expect(skeleton()).toBeNull();
    expect(screen.queryByRole("region", { name: "Selected element" })).not.toBeNull();
  });

  it("does not blank the slot between two skeletons when a second pick lands in the dwell", async () => {
    // The gate and the floor run on their own clocks: a pick arriving inside
    // the previous one's dwell restarts the gate while the floor expires
    // under it, which used to put an empty header between two skeletons.
    await mountBound();
    let release = holdResolve();
    vi.useFakeTimers();

    await act(async () => host.select(0));
    await elapse(GATE_MS);
    expect(skeleton()).not.toBeNull();

    // First answer lands, then a fresh pick 10ms later — inside the floor.
    release();
    await elapse(10);
    release = holdResolve();
    await act(async () => host.select(0));

    // Across the whole window the first floor would have expired in, and the
    // whole window the second gate would have been running in.
    for (const step of [100, 140, 200, 200]) {
      await elapse(step);
      expect(skeleton()).not.toBeNull();
    }

    release();
    await elapse(FLOOR_MS + 1);
    expect(skeleton()).toBeNull();
    expect(screen.queryByRole("region", { name: "Selected element" })).not.toBeNull();
  });

  it("starts the wait again when the drawer is folded away and brought back", async () => {
    // Both halves measure time on screen. A folded drawer shows nothing to
    // dwell on, so a floor started behind it used to expire moments after the
    // drawer came back — a skeleton, a blank header, then a skeleton again.
    await mountBound();
    const release = holdResolve();
    vi.useFakeTimers();

    await act(async () => host.select(0));
    await elapse(GATE_MS);
    expect(skeleton()).not.toBeNull();

    act(() => setDrawerCollapsed("preview-1", true));
    await elapse(220);
    expect(skeleton()).toBeNull();

    act(() => setDrawerCollapsed("preview-1", false));
    // A fresh gate, not the tail of the old floor: nothing, then the skeleton.
    await elapse(GATE_MS - 1);
    expect(skeleton()).toBeNull();
    await elapse(1);
    expect(skeleton()).not.toBeNull();
    // And it is still there well past where the original floor would have run out.
    await elapse(FLOOR_MS);
    expect(skeleton()).not.toBeNull();

    release();
    await elapse(FLOOR_MS + 1);
    expect(screen.queryByRole("region", { name: "Selected element" })).not.toBeNull();
  });

  it("lands a crumb's focus on the identity the floor was holding back", async () => {
    // Without the landing-readiness half of the fix the settling effect spends
    // the focus intent on an identity the skeleton has not released yet, and
    // focus is simply lost.
    await mountSelected();
    const identity = screen.getByRole("region", { name: "Selected element" });
    const crumb = within(identity).getByRole("button", { name: "PricingCard" });
    crumb.focus();

    const release = holdResolve();
    vi.useFakeTimers();
    fireEvent.click(crumb);
    // The fake page answers a reselect on the next tick, then the host is held.
    await elapse(GATE_MS);
    expect(skeleton()).not.toBeNull();

    release();
    await elapse(10);
    // The answer is in, but the floor still owns the slot — so the landing the
    // intent is aimed at has not been rendered yet.
    expect(skeleton()).not.toBeNull();
    expect(screen.queryByRole("region", { name: "Selected element" })).toBeNull();

    await elapse(FLOOR_MS);
    const landed = screen.getByRole("region", { name: "Selected element" });
    expect(document.activeElement).toBe(landed);
  });
});

/**
 * An agent beside the preview. Each test names its own: delivery remembers,
 * per terminal, that it just typed into one, and holds the next request
 * until that agent has been seen at work.
 */
function withAgent(terminalId: string, cwd?: string) {
  usePanelStore.setState({
    panelIds: ["preview-1", terminalId],
    panelsById: {
      "preview-1": {
        id: "preview-1",
        kind: "dev-preview",
        location: "grid",
        worktreeId: "wt-1",
        ...(cwd ? { cwd } : {}),
      },
      [terminalId]: {
        id: terminalId,
        kind: "terminal",
        location: "grid",
        worktreeId: "wt-1",
        hasPty: true,
        title: "claude · react app",
        launchAgentId: "claude",
        detectedAgentId: "claude",
        agentState: "waiting",
      },
    } as never,
  });
}

describe("an element with nothing to trace", () => {
  it("sends the element's selector, markup, styles and picture, saying the source is not traced", async () => {
    withAgent("term-picked");
    const sent = await recordSends();
    await mountBound();
    await act(async () => host.select(0, [PAGE_NODE]));

    await screen.findByRole("textbox", { name: "Request for the agent" });
    const identity = screen.getByRole("region", { name: "Selected element" });
    expect(identity.textContent).toContain("main > button.cta");
    expect(identity.textContent).toContain("No source reported for this element");
    // Taken when the element was picked, cropped to the box the page measured.
    expect(host.captureElement).toHaveBeenCalledWith("preview-1", {
      rect: { x: 40, y: 80, width: 120, height: 40 },
      viewportWidth: 800,
      viewportHeight: 600,
    });

    const prompt = await sendRequest(sent);
    expect(prompt).toContain("Make this bigger");
    expect(prompt).toContain("- Source: not traced");
    expect(prompt).toContain('- Selector: "main > button.cta"');
    expect(prompt).toContain('\\"cta\\"');
    expect(prompt).toContain('"display: inline-flex; padding: 8px 16px"');
    expect(prompt).toContain("/tmp/daintree-clipboard/element-1.png");
    // The page's address is redacted the way a traced selection's is.
    expect(prompt).toContain('"http://localhost:5173/pricing?plan="');
    // Nothing was asked of the host: there is no source to trace it to, and no
    // app is named for an element nobody placed in one.
    expect(host.calls("resolve")).toEqual([]);
    expect(prompt).not.toContain("- App:");
    expect(prompt).toContain("no source file was traced");
    expect(prompt).not.toContain("file references");
  });

  it("leaves what a request includes to the Includes row, which says when there is no picture", async () => {
    withAgent("term-noshot");
    host.captureElement.mockResolvedValueOnce({ status: "offscreen" });
    await mountBound();
    await act(async () => host.select(0, [PAGE_NODE]));

    await screen.findByRole("textbox", { name: "Request for the agent" });
    const identity = screen.getByRole("region", { name: "Selected element" });
    expect(identity.textContent).toContain("No source reported for this element");
    // The notice says why there is no source, never what a request carries.
    expect(identity.textContent).not.toMatch(/screenshot|markup|styles|request carries/i);
    // Parts keep their words together with non-breaking spaces.
    await waitFor(() =>
      expect(document.querySelector("[data-composer-includes]")?.textContent).toMatch(
        /no\sscreenshot/
      )
    );
  });

  it("goes without a picture, and says why, when the element is off screen", async () => {
    withAgent("term-offscreen");
    const sent = await recordSends();
    host.captureElement.mockResolvedValueOnce({ status: "offscreen" });
    await mountBound();
    await act(async () => host.select(0, [PAGE_NODE]));
    const prompt = await sendRequest(sent);
    expect(prompt).toContain(
      "- Screenshot: not attached — the element is outside the visible page"
    );
  });

  it("goes without a picture in a window attached to another machine, where a local path means nothing", async () => {
    withAgent("term-remote");
    const sent = await recordSends();
    const global = window as unknown as { __DAINTREE_HOST_ID__?: { id: string } };
    global.__DAINTREE_HOST_ID__ = { id: "build-box" };
    try {
      await mountBound();
      await act(async () => host.select(0, [PAGE_NODE]));
      const prompt = await sendRequest(sent);
      expect(host.captureElement).not.toHaveBeenCalled();
      expect(prompt).toContain(
        "- Screenshot: not attached — this window is attached to another machine"
      );
      // This machine's address for the page names something else where the
      // source is: the workspace is asked to fetch no maps rather than the wrong ones.
      expect(host.calls("openWorkspace").at(-1)).not.toHaveProperty("previewOrigin");
    } finally {
      delete global.__DAINTREE_HOST_ID__;
    }
  });

  it("doesn't hold an untraced click for the worktree's source to open", async () => {
    let answer: (result: ElementPickerWorkspaceOpenResult) => void = () => {};
    host.openWith = () => new Promise((resolve) => (answer = resolve));
    mount();
    await waitFor(() => expect(host.picker.bind).toHaveBeenCalled());
    await screen.findByRole("radio", { name: "Browse" });
    await act(async () => host.documentReady(0));
    await act(async () => host.select(0, [PAGE_NODE]));
    // Nothing on the element is any framework's, so it is the page's account
    // whatever the workspace turns out to be — sendable now, its picture taken
    // at the click.
    await screen.findByRole("textbox", { name: "Request for the agent" });
    expect(host.captureElement).toHaveBeenCalledTimes(1);

    await act(async () =>
      answer({
        status: "ready",
        workspaceId: "ws-1",
        appPath: ".",
        appPaths: ["."],
        scanComplete: true,
      })
    );
    // No second picture of whatever sits there now, and nothing to resolve.
    expect(host.captureElement).toHaveBeenCalledTimes(1);
    expect(host.calls("resolve")).toEqual([]);
  });

  it("holds a traced click made while the source opens, and resolves it once it has", async () => {
    let answer: (result: ElementPickerWorkspaceOpenResult) => void = () => {};
    host.openWith = () => new Promise((resolve) => (answer = resolve));
    mount();
    await waitFor(() => expect(host.picker.bind).toHaveBeenCalled());
    await screen.findByRole("radio", { name: "Browse" });
    await act(async () => host.documentReady(0));
    await act(async () => host.select(0));
    expect(session().getSnapshot().selection.status).toBe("resolving");
    expect(screen.queryByRole("textbox", { name: "Request for the agent" })).toBeNull();
    expect(host.calls("resolve")).toEqual([]);
    // The picture is taken at the click, while the page still shows it.
    expect(host.captureElement).toHaveBeenCalledTimes(1);

    await act(async () =>
      answer({
        status: "ready",
        workspaceId: "ws-1",
        appPath: ".",
        appPaths: ["."],
        scanComplete: true,
      })
    );
    await screen.findByRole("textbox", { name: "Request for the agent" });
    expect(host.calls("resolve")).toHaveLength(1);
    expect(host.captureElement).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("region", { name: "Selected element" }).textContent).toContain(
      `${FILE}:6`
    );
  });

  it("keeps a held click across the source reopening for the page's server", async () => {
    const answers: Array<(result: ElementPickerWorkspaceOpenResult) => void> = [];
    host.openWith = () => new Promise((resolve) => answers.push(resolve));
    await mountBound();
    await act(async () => host.select(0));
    expect(session().getSnapshot().selection.status).toBe("resolving");

    // The page's address only now reaches the picker, naming another origin:
    // the source is opened again for it, and the click waits for that one.
    await act(async () =>
      publishDevPreviewToolContext({ ...hostContext(), url: "http://localhost:3000/pricing" })
    );
    await waitFor(() => expect(answers.length).toBeGreaterThan(1));
    expect(session().getSnapshot().selection.status).toBe("resolving");
    await act(async () =>
      answers.at(-1)?.({
        status: "ready",
        workspaceId: "ws-2",
        appPath: ".",
        appPaths: ["."],
        scanComplete: true,
      })
    );
    await waitFor(() => expect(host.calls("resolve")).toHaveLength(1));
    expect(host.calls("resolve")[0]?.workspaceId).toBe("ws-2");
  });

  it("gives a held click back as the page's account when the source can't be opened", async () => {
    withAgent("term-held");
    const sent = await recordSends();
    let answer: (result: ElementPickerWorkspaceOpenResult) => void = () => {};
    host.openWith = () => new Promise((resolve) => (answer = resolve));
    await mountBound();
    await act(async () => host.select(0));
    expect(session().getSnapshot().selection.status).toBe("resolving");

    await act(async () => answer({ status: "unavailable", reason: "unknown-worktree" }));
    const identity = await screen.findByRole("region", { name: "Selected element" });
    // The page said where it is written; nothing here could check it.
    expect(identity.textContent).toContain("Location not checked against source");
    expect(host.calls("resolve")).toEqual([]);
    const prompt = await sendRequest(sent);
    // The picture taken at the click, of what was clicked.
    expect(host.captureElement).toHaveBeenCalledTimes(1);
    expect(prompt).toContain(
      "- Screenshot of the selection, cropped from the preview: /tmp/daintree-clipboard/element-1.png"
    );
    expect(prompt).toContain("not checked");
  });

  it("sends what the page shows, naming no app, when the worktree's source opened for another one", async () => {
    host.openWith = () => ({
      status: "ready",
      workspaceId: "ws-1",
      appPath: "apps/docs",
      appPaths: ["apps/docs"],
      scanComplete: true,
    });
    withAgent("term-beside", "/repo/apps/web");
    const sent = await recordSends();
    await mountBound();
    await waitFor(() => expect(session().getSnapshot().workspace.status).toBe("ready"));
    await act(async () => host.select(0, [PAGE_NODE]));

    const prompt = await sendRequest(sent);
    expect(prompt).toContain('- Selector: "main > button.cta"');
    expect(prompt).not.toContain("- App:");
    expect(prompt).not.toContain("apps/docs");
    expect(host.calls("resolve")).toEqual([]);
  });

  it("sends what the page shows without choosing an app when several could be it", async () => {
    host.openWith = () => ({
      status: "ambiguous",
      appPaths: ["apps/docs", "apps/admin"],
      scanComplete: true,
    });
    withAgent("term-ambiguous", "/repo/apps/web");
    const sent = await recordSends();
    await mountBound();
    await waitFor(() => expect(session().getSnapshot().workspace.status).toBe("ambiguous"));
    await act(async () => host.select(0, [PAGE_NODE]));

    const prompt = await sendRequest(sent);
    expect(prompt).toContain('- Selector: "main > button.cta"');
    expect(prompt).not.toContain("- App:");
    expect(host.calls("resolve")).toEqual([]);
    expect(host.calls("openWorkspace").every((request) => request.appPath === undefined)).toBe(
      true
    );
    expect(session().getSnapshot().workspace.status).toBe("ambiguous");
    // The choice is there for tracing, not asked for before this can be sent.
    expect(text()).not.toContain("Choose which app this preview shows");
  });

  it("keeps a request being written about a page selection when the selection clears", async () => {
    host.openWith = () => ({
      status: "ambiguous",
      appPaths: ["apps/docs", "apps/admin"],
      scanComplete: true,
    });
    await mountBound();
    await waitFor(() => expect(session().getSnapshot().workspace.status).toBe("ambiguous"));
    await act(async () => host.select(0, [PAGE_NODE]));
    const request = await screen.findByRole("textbox", { name: "Request for the agent" });
    fireEvent.change(request, { target: { value: "Make this bigger" } });
    await act(async () => host.select(0, []));
    expect(session().getSnapshot().selection.status).toBe("none");
    const kept = screen.getByRole("textbox", {
      name: "Request for the agent",
    }) as HTMLTextAreaElement;
    expect(kept.value).toBe("Make this bigger");
  });

  it("asks nothing of the host while the pointer moves over the page", async () => {
    await mountBound();
    await act(async () => host.hover(svelteObservation()));
    await act(async () => host.hover(PAGE_NODE));
    await act(async () => host.hover(null));
    expect(host.calls("resolve")).toEqual([]);
    expect(host.captureElement).not.toHaveBeenCalled();
  });

  /** An element Svelte rendered from raw `{@html}`: no position stamped, only its place in the template. */
  const RAW_HTML: SelectionObservation = svelteObservation({
    elementId: "el-raw",
    tagName: "P",
    label: "p",
    componentChain: { nearestId: null, components: [], truncated: false },
    sourceCandidates: [{ ...STAMP, candidateId: "svelte-raw", location: null }],
    frameworkEvidence: [
      {
        kind: "svelte",
        ancestry: [],
        sameLocCount: 1,
        structure: { file: FILE, path: [{ tag: "p", index: 0 }] },
        unmapped: false,
      },
    ],
  });

  it.each([
    ["a traced element beside it", [svelteObservation(), PAGE_NODE]],
    ["an untraced element listed first", [PAGE_NODE, svelteObservation()]],
    ["an element placed only by its template's shape", [RAW_HTML]],
    [
      "a component chain above it",
      [{ ...PAGE_NODE, componentChain: svelteObservation().componentChain }],
    ],
  ])("still traces a selection with %s", async (_name, observations) => {
    await mountBound();
    await act(async () => host.select(0, observations));
    await waitFor(() => expect(host.calls("resolve")).toHaveLength(1));
    const resolved = host.calls("resolve")[0]!.observations;
    expect(resolved.map((observation) => observation.elementId)).toEqual(
      observations.map((observation) => observation.elementId)
    );
    expect(resolved.some((observation) => "context" in observation)).toBe(false);
  });

  it("pairs a traced selection with its own picture and page account, not an earlier one's", async () => {
    withAgent("term-reselected");
    const sent = await recordSends();
    const saved = (filePath: string) => ({
      status: "saved" as const,
      filePath,
      width: 10,
      height: 10,
    });
    host.captureElement
      .mockResolvedValueOnce(saved("/tmp/daintree-clipboard/first.png"))
      .mockResolvedValueOnce(saved("/tmp/daintree-clipboard/second.png"));
    await mountBound();
    const withSelector = (selector: string) =>
      svelteObservation({ context: { ...PAGE_NODE.context!, selector } });
    await act(async () => host.select(0, [withSelector("main > button.first")]));
    await waitFor(() => expect(host.calls("resolve")).toHaveLength(1));
    await act(async () => host.select(0, [withSelector("main > button.second")]));
    await waitFor(() => expect(host.calls("resolve")).toHaveLength(2));

    const prompt = await sendRequest(sent);
    expect(prompt).toContain('- Selector: "main > button.second"');
    expect(prompt).toContain("/tmp/daintree-clipboard/second.png");
    expect(prompt).not.toContain("button.first");
    expect(prompt).not.toContain("first.png");
  });

  it("sends a traced element's source with what the page showed of it and its picture", async () => {
    withAgent("term-traced");
    const sent = await recordSends();
    await mountBound();
    await act(async () => host.select(0, [svelteObservation({ context: PAGE_NODE.context })]));
    await waitFor(() => expect(host.calls("resolve")).toHaveLength(1));
    // Taken at the click, before the drawer opens and moves the element, of
    // the box the page measured.
    expect(host.captureElement).toHaveBeenCalledTimes(1);
    expect(host.captureElement).toHaveBeenCalledWith("preview-1", {
      rect: { x: 0, y: 0, width: 10, height: 10 },
      viewportWidth: 800,
      viewportHeight: 600,
    });

    const prompt = await sendRequest(sent);
    expect(prompt).toContain(`- Source: written at ${FILE}:6:3 (`);
    expect(prompt).toContain("checked against the file)");
    expect(prompt).toContain('- Selector: "main > button.cta"');
    expect(prompt).toContain('"display: inline-flex; padding: 8px 16px"');
    expect(prompt).toContain("/tmp/daintree-clipboard/element-1.png");
    expect(prompt).toContain("- App: the worktree root");
  });

  it("checks every claim the host was asked about, and only those, before a request goes", async () => {
    // A chain the fixtures know nothing of, every claim verified where the page
    // put it: what a request cites is exactly what the host read.
    const chain = svelteChain([
      { id: "c-badge", name: "Badge", file: "src/routes/+layout.svelte", line: 2, column: 0 },
    ]);
    host.template = () => chain;
    host.resultsFor = (observation) => verifyAll(observation);
    await mountSelected();
    const state = session().getSnapshot().selection;
    if (state.status !== "ready") throw new Error("not ready");
    expect(Object.keys(citedRevisions(state.selection)).sort()).toEqual(
      ["src/routes/+layout.svelte", FILE].sort()
    );
    expect(await session().sourcesUnchanged(state.selection)).toBe(true);
    expect(host.calls("sourceRevisions").at(-1)?.paths.sort()).toEqual(
      ["src/routes/+layout.svelte", FILE].sort()
    );
  });
});
