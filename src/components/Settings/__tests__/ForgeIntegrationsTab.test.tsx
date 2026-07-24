// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import { render, screen, waitFor } from "@testing-library/react";
import { ForgeIntegrationsTab } from "../ForgeIntegrationsTab";
import { useProjectStore } from "@/store/projectStore";
import type {
  ForgeProviderEntry,
  ResolvedForgeProvider,
  ForgeProviderResolutionVia,
} from "@shared/types";
import type { Project } from "@shared/types/project";
import type { RemoteInfo } from "@shared/types/ipc/forge";

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
  logDebug: vi.fn(),
}));

// Avoid pulling in the heavy Radix loader / tooltip provider plumbing.
// Tooltips render their trigger inline; content is hidden until hover, and
// we don't assert on tooltip text here.
vi.mock("@/components/ui/tooltip", () => {
  const Pass = ({ children }: { children: React.ReactNode }) => <>{children}</>;
  return {
    Tooltip: Pass,
    TooltipTrigger: Pass,
    TooltipContent: () => null,
    TooltipProvider: Pass,
  };
});

function makeProvider(
  pluginId: string,
  id: string,
  name: string,
  matches: string[] = []
): ForgeProviderEntry {
  return {
    pluginId,
    contribution: { id, name, matches },
  };
}

function makeRemote(name: string, fetchUrl: string): RemoteInfo {
  return { name, fetchUrl, parsedRepo: null };
}

function setProject(project: Project | null) {
  useProjectStore.setState({ currentProject: project });
}

interface ForgeMockOptions {
  defaultProviderId?: string | null;
  providers?: ForgeProviderEntry[];
  remotes?: RemoteInfo[] | Error;
  resolveByRemote?: Record<string, ResolvedForgeProvider>;
  /** The project's stored forge remote name; undefined means auto-detect. */
  forgeRemote?: string;
}

function installForgeMocks(opts: ForgeMockOptions = {}) {
  const setDefault = vi.fn(async (id: string | null) => ({ defaultProviderId: id }));
  window.electron = {
    forge: {
      getSettings: vi.fn(async () => ({ defaultProviderId: opts.defaultProviderId ?? null })),
      setDefaultProvider: setDefault,
      getProviders: vi.fn(async () => opts.providers ?? []),
      resolveProvider: vi.fn(async (_projectId: string, remoteUrl?: string) => {
        const noMatch: ResolvedForgeProvider = { entry: null, resolvedVia: null };
        if (!remoteUrl) return noMatch;
        return opts.resolveByRemote?.[remoteUrl] ?? noMatch;
      }),
    },
    project: {
      listRemotes: vi.fn(async () => {
        if (opts.remotes instanceof Error) throw opts.remotes;
        return opts.remotes ?? [];
      }),
      // Drives which remote the panel labels "Active" (#11408).
      getSettings: vi.fn(async () => ({ forgeRemote: opts.forgeRemote })),
    },
  } as unknown as typeof window.electron;
  return { setDefault };
}

beforeEach(() => {
  vi.clearAllMocks();
  setProject(null);
});

describe("ForgeIntegrationsTab", () => {
  it("renders both sections and the empty-project hint when no project is open", async () => {
    installForgeMocks({ providers: [makeProvider("builtin", "github", "GitHub", ["github.com"])] });
    render(<ForgeIntegrationsTab />);

    await waitFor(() => {
      expect(screen.getByText("Default forge provider")).toBeTruthy();
      expect(screen.getByText("Active project routing")).toBeTruthy();
    });
    expect(screen.getByText(/Open a project to view its forge routing/i)).toBeTruthy();
    expect(window.electron.project.listRemotes).not.toHaveBeenCalled();
  });

  describe("active remote marker (#11408)", () => {
    const github = makeProvider("builtin", "github", "GitHub", ["github.com"]);
    const ORIGIN_URL = "git@github.com:me/fork.git";
    const UPSTREAM_URL = "git@github.com:acme/canonical.git";

    function renderWithBothRemotes(forgeRemote?: string) {
      installForgeMocks({
        providers: [github],
        remotes: [makeRemote("origin", ORIGIN_URL), makeRemote("upstream", UPSTREAM_URL)],
        resolveByRemote: {
          [ORIGIN_URL]: { entry: github, resolvedVia: "hostname" },
          [UPSTREAM_URL]: { entry: github, resolvedVia: "hostname" },
        },
        forgeRemote,
      });
      setProject({ id: "proj-1", path: "/repo", name: "Repo" } as Project);
      render(<ForgeIntegrationsTab />);
    }

    /** The row `<li>` whose remote name cell matches. */
    function rowFor(name: string): HTMLElement {
      const cell = screen.getByText(name);
      const row = cell.closest("li");
      if (!row) throw new Error(`No routing row found for remote "${name}"`);
      return row;
    }

    it("marks the remote named by the project setting", async () => {
      renderWithBothRemotes("upstream");

      await waitFor(() => expect(screen.getByText("Active")).toBeTruthy());
      expect(rowFor("upstream").textContent).toContain("Active");
      expect(rowFor("origin").textContent).not.toContain("Active");
    });

    it("marks the auto-detected remote when no setting is stored", async () => {
      // Both match a provider, so name preference picks upstream over origin.
      renderWithBothRemotes(undefined);

      await waitFor(() => expect(screen.getByText("Active")).toBeTruthy());
      expect(rowFor("upstream").textContent).toContain("Active");
      expect(rowFor("origin").textContent).not.toContain("Active");
    });

    it("marks exactly one remote", async () => {
      renderWithBothRemotes("origin");

      await waitFor(() => expect(screen.getByText("Active")).toBeTruthy());
      expect(screen.getAllByText("Active")).toHaveLength(1);
      expect(rowFor("origin").textContent).toContain("Active");
    });
  });

  it("renders a routing row per remote with the resolved provider badge", async () => {
    const github = makeProvider("builtin", "github", "GitHub", ["github.com"]);
    const gitea = makeProvider("acme.gitea", "gitea", "Gitea", ["gitea.example.com"]);
    const remotes = [
      makeRemote("origin", "git@github.com:owner/repo.git"),
      makeRemote("mirror", "git@gitea.example.com:owner/repo.git"),
    ];
    installForgeMocks({
      providers: [github, gitea],
      remotes,
      resolveByRemote: {
        "git@github.com:owner/repo.git": { entry: github, resolvedVia: "hostname" },
        "git@gitea.example.com:owner/repo.git": { entry: gitea, resolvedVia: "hostname" },
      },
    });
    setProject({ id: "proj-1", path: "/repo", name: "Repo" } as Project);

    render(<ForgeIntegrationsTab />);

    await waitFor(() => {
      expect(screen.getByText("origin")).toBeTruthy();
      expect(screen.getByText("mirror")).toBeTruthy();
      expect(screen.getByText("GitHub")).toBeTruthy();
      expect(screen.getByText("Gitea")).toBeTruthy();
    });
    expect(window.electron.forge.resolveProvider).toHaveBeenCalledWith(
      "proj-1",
      "git@github.com:owner/repo.git"
    );
    expect(window.electron.forge.resolveProvider).toHaveBeenCalledWith(
      "proj-1",
      "git@gitea.example.com:owner/repo.git"
    );
  });

  it("renders a No match badge when the resolver returns null entry", async () => {
    const noMatch: ResolvedForgeProvider = { entry: null, resolvedVia: null };
    const github = makeProvider("builtin", "github", "GitHub", ["github.com"]);
    installForgeMocks({
      providers: [github],
      remotes: [makeRemote("origin", "git@unknown.example:owner/repo.git")],
      resolveByRemote: {
        "git@unknown.example:owner/repo.git": noMatch,
      },
    });
    setProject({ id: "proj-1", path: "/repo", name: "Repo" } as Project);

    render(<ForgeIntegrationsTab />);

    await waitFor(() => {
      expect(screen.getByText("No match")).toBeTruthy();
    });
  });

  it("shows a no-remotes message when the project has zero git remotes", async () => {
    installForgeMocks({
      providers: [makeProvider("builtin", "github", "GitHub", ["github.com"])],
      remotes: [],
    });
    setProject({ id: "proj-1", path: "/repo", name: "Repo" } as Project);

    render(<ForgeIntegrationsTab />);

    await waitFor(() => {
      expect(screen.getByText(/has no git remotes configured/i)).toBeTruthy();
    });
  });

  it("does not flash the no-remotes empty state while a load is in flight (#9990)", async () => {
    // listRemotes never resolves, so the load stays in flight: remotesLoading
    // is true and remotes stays []. Within the 400ms Doherty window the gated
    // `showRemotesLoading` is still false, which previously fell through to the
    // "has no git remotes configured" empty state.
    installForgeMocks({
      providers: [makeProvider("builtin", "github", "GitHub", ["github.com"])],
    });
    window.electron.project.listRemotes = vi.fn(() => new Promise<RemoteInfo[]>(() => {}));
    setProject({ id: "proj-pending", path: "/pending", name: "Pending" } as Project);

    render(<ForgeIntegrationsTab />);

    // Wait until the top-level settings load settles (providers resolved) so we
    // know the component has rendered past its own loading state.
    await waitFor(() => {
      expect(screen.getByText("Active project routing")).toBeTruthy();
    });
    expect(window.electron.project.listRemotes).toHaveBeenCalledWith("/pending");
    // The panel renders nothing during the in-flight window — no false empty state.
    expect(screen.queryByText(/has no git remotes configured/i)).toBeNull();
  });

  it("shows the no-providers note alongside the remotes list when no plugins are installed", async () => {
    installForgeMocks({
      providers: [],
      remotes: [makeRemote("origin", "git@github.com:owner/repo.git")],
      resolveByRemote: {
        "git@github.com:owner/repo.git": { entry: null, resolvedVia: null },
      },
    });
    setProject({ id: "proj-2", path: "/repo2", name: "Repo2" } as Project);

    render(<ForgeIntegrationsTab />);

    await waitFor(() => {
      // The informational note remains visible in the routing panel. Match the
      // phrase unique to it — the default-provider section also says "No forge
      // plugins are installed yet." which getByText would otherwise conflate.
      expect(screen.getByText(/Each remote shows as unmatched/i)).toBeTruthy();
      // …and the remote row with its "No match" badge is now rendered too,
      // instead of being hidden behind a text-only early return (#9990).
      expect(screen.getByText("origin")).toBeTruthy();
      expect(screen.getByText("No match")).toBeTruthy();
    });
  });

  it("shows an error message when listRemotes rejects", async () => {
    installForgeMocks({
      providers: [makeProvider("builtin", "github", "GitHub", ["github.com"])],
      remotes: new Error("not a git repo"),
    });
    setProject({ id: "proj-1", path: "/repo", name: "Repo" } as Project);

    render(<ForgeIntegrationsTab />);

    await waitFor(() => {
      expect(screen.getByText(/Couldn't read git remotes|not a git repo/i)).toBeTruthy();
    });
  });

  it("reloads remotes when the active project changes", async () => {
    const github = makeProvider("builtin", "github", "GitHub", ["github.com"]);
    const remoteA = makeRemote("origin", "git@github.com:a/a.git");
    const remoteB = makeRemote("origin", "git@github.com:b/b.git");

    installForgeMocks({
      providers: [github],
      remotes: [remoteA],
      resolveByRemote: {
        "git@github.com:a/a.git": { entry: github, resolvedVia: "hostname" },
      },
    });
    setProject({ id: "proj-a", path: "/a", name: "A" } as Project);

    const { rerender } = render(<ForgeIntegrationsTab />);

    await waitFor(() => {
      expect(screen.getByText("origin")).toBeTruthy();
    });
    expect(window.electron.project.listRemotes).toHaveBeenCalledWith("/a");

    installForgeMocks({
      providers: [github],
      remotes: [remoteB],
      resolveByRemote: {
        "git@github.com:b/b.git": { entry: github, resolvedVia: "hostname" },
      },
    });
    setProject({ id: "proj-b", path: "/b", name: "B" } as Project);
    rerender(<ForgeIntegrationsTab />);

    await waitFor(() => {
      expect(window.electron.project.listRemotes).toHaveBeenCalledWith("/b");
    });
  });

  it("displays an override-resolved badge for the override precedence path", async () => {
    const gitea = makeProvider("acme.gitea", "gitea", "Gitea", ["gitea.example.com"]);
    const overrideResult: ResolvedForgeProvider = {
      entry: gitea,
      resolvedVia: "override" satisfies ForgeProviderResolutionVia,
    };
    installForgeMocks({
      providers: [gitea],
      remotes: [makeRemote("origin", "git@github.com:owner/repo.git")],
      resolveByRemote: {
        "git@github.com:owner/repo.git": overrideResult,
      },
    });
    setProject({ id: "proj-1", path: "/repo", name: "Repo" } as Project);

    render(<ForgeIntegrationsTab />);

    await waitFor(() => {
      expect(screen.getByText("Gitea")).toBeTruthy();
      expect(screen.getByText(/override/i)).toBeTruthy();
    });
  });
});

describe("ForgeIntegrationsTab source guards", () => {
  let source: string;

  beforeEach(async () => {
    source = await fs.readFile(path.resolve(__dirname, "../ForgeIntegrationsTab.tsx"), "utf-8");
  });

  it("gates the remotes loading text on useDohertyGate", () => {
    expect(source).toContain("useDohertyGate");
    expect(source).toMatch(/showRemotesLoading\s*=\s*useDohertyGate\(\s*remotesLoading\s*\)/);
    expect(source).toMatch(/loading=\{showRemotesLoading\}/);
    expect(source).not.toMatch(/loading=\{remotesLoading\}/);
  });

  it("passes a raw pending flag to suppress the empty state during in-flight loads", () => {
    expect(source).toMatch(/pending=\{remotesPending\}/);
    // pending covers the active load AND the pre-effect frame on a project switch.
    expect(source).toMatch(/remotesPending\s*=\s*\n?\s*remotesLoading\s*\|\|/);
    expect(source).toMatch(/remotesLoadedForRef\.current\s*!==\s*activeProjectId/);
    // The panel returns null during the in-flight window before the Doherty gate fires.
    expect(source).toMatch(/if\s*\(\s*pending\s*&&\s*!loading\s*&&\s*remotes\.length === 0\s*\)/);
  });

  it("reads remotes through a ref in reresolveRemotes to avoid stale closures on project switch", () => {
    // Ref mirrors for both remotes and the active project id
    expect(source).toMatch(/remotesRef\s*=\s*useRef<RemoteRouting\[\]>\(\[\]\)/);
    expect(source).toMatch(
      /activeProjectIdRef\s*=\s*useRef<string \| undefined>\(activeProjectId\)/
    );
    // Refs kept in sync with their source state via effects
    expect(source).toMatch(/remotesRef\.current\s*=\s*remotes/);
    expect(source).toMatch(/activeProjectIdRef\.current\s*=\s*activeProjectId/);
    // reresolveRemotes reads project id + remotes from refs, not from closures
    expect(source).toMatch(/const\s+currentProjectId\s*=\s*activeProjectIdRef\.current/);
    expect(source).toMatch(/const\s+currentRemotes\s*=\s*remotesRef\.current\.map/);
    expect(source).not.toMatch(/const\s+currentRemotes\s*=\s*remotes\.map/);
    // Resolver is called with the ref-captured projectId, never the closure-bound activeProjectId
    expect(source).toMatch(/resolveProvider\(currentProjectId,\s*remote\.fetchUrl\)/);
    // Bail-out guard after the awaited resolutions if the project switched
    expect(source).toMatch(
      /if\s*\(\s*activeProjectIdRef\.current\s*!==\s*currentProjectId\s*\)\s*return\s*;?/
    );
  });
});
