import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { Server } from "lucide-react";
import { resolveAppTheme } from "@shared/theme/themes";
import type { ProjectMatchCandidate } from "@shared/types/ipc/projectMatch";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppDialog } from "@/components/ui/AppDialog";
import { Button } from "@/components/ui/button";
import { ProjectMatchChooser } from "../ProjectMatchChooser";
import "@/index.css";

/**
 * Visual-review harness for the repository-copy chooser in the host switch
 * dialog. The real chooser inside the real `AppDialog`; the links and footer
 * around it are the dialog's own markup copied as decoration.
 *
 * Query parameters:
 *   ?theme=daintree|bondi|…   built-in theme id
 *   ?state=<name>             one of MATCH_STATES below
 *   ?busy=1                   the chooser disabled, as while a step runs
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const stateName = params.get("state") ?? "several-clones";
const busy = params.get("busy") === "1";

const HOST = "greg-studio";
const minutesAgo = (n: number) => Date.now() - n * 60_000;
const daysAgo = (n: number) => minutesAgo(n * 24 * 60);

const ORIGIN = { name: "origin", url: "git@github.com:gpriday/daintree.git" };
const UPSTREAM = { name: "upstream", url: "https://github.com/daintreehq/daintree.git" };

function candidate(over: Partial<ProjectMatchCandidate>): ProjectMatchCandidate {
  return {
    projectId: "p",
    path: "/Users/greg/Projects/daintree",
    name: "daintree",
    remotes: [ORIGIN, UPSTREAM],
    source: "registered",
    matchedBy: "remote-url",
    lastOpenedAt: minutesAgo(120),
    ...over,
  };
}

interface MatchState {
  sourceRemotes: Array<{ name: string; url: string }>;
  candidates: ProjectMatchCandidate[];
  selected?: number;
}

export const MATCH_STATES: Record<string, MatchState> = {
  /** Four copies of one repository, three of them called the same thing. */
  "several-clones": {
    sourceRemotes: [ORIGIN, UPSTREAM],
    candidates: [
      candidate({ projectId: "a" }),
      candidate({
        projectId: "b",
        path: "/Users/greg/work/daintree",
        remotes: [UPSTREAM],
        lastOpenedAt: daysAgo(21),
      }),
      candidate({
        projectId: null,
        path: "/Users/greg/src/github.com/daintreehq/daintree",
        source: "on-disk",
        lastOpenedAt: daysAgo(5),
      }),
      candidate({
        projectId: "d",
        name: "daintree-experiments",
        path: "/Users/greg/Projects/forks/daintree-experiments",
        remotes: [{ name: "origin", url: "git@gitlab.com:greg/daintree-experiments.git" }],
        matchedBy: "committed-id",
        lastOpenedAt: daysAgo(64),
      }),
    ],
  },
  /** Near-identical clones: same name, same remotes, paths differing deep inside. */
  "near-identical": {
    sourceRemotes: [ORIGIN],
    candidates: [
      candidate({ projectId: "a", path: "/Users/greg/Projects/daintree", remotes: [ORIGIN] }),
      candidate({
        projectId: "b",
        path: "/Users/greg/Projects/daintree-worktrees/daintree",
        remotes: [ORIGIN],
        lastOpenedAt: daysAgo(2),
      }),
      candidate({
        projectId: "c",
        path: "/Users/greg/Projects/archive/2025/daintree",
        remotes: [ORIGIN],
        lastOpenedAt: daysAgo(190),
      }),
    ],
  },
  /** A long shared prefix and the same folder name, differing only in one middle folder. */
  "deep-prefix": {
    sourceRemotes: [ORIGIN],
    candidates: [
      candidate({
        projectId: "a",
        path: "/Users/greg/Library/Mobile Documents/com~apple~CloudDocs/Engineering/clients/acme/main/daintree",
        remotes: [ORIGIN],
      }),
      candidate({
        projectId: "b",
        path: "/Users/greg/Library/Mobile Documents/com~apple~CloudDocs/Engineering/clients/acme/release-2026-09/daintree",
        remotes: [ORIGIN],
        lastOpenedAt: daysAgo(9),
      }),
      candidate({
        projectId: null,
        path: "/Users/greg/Library/Mobile Documents/com~apple~CloudDocs/Engineering/clients/acme/hotfix/daintree",
        source: "on-disk",
        remotes: [ORIGIN],
        lastOpenedAt: daysAgo(30),
      }),
    ],
  },
  /** Long paths and several remotes each. */
  "long-paths": {
    sourceRemotes: [ORIGIN, UPSTREAM],
    selected: 1,
    candidates: [
      candidate({
        projectId: "a",
        name: "daintree-monorepo-integration-sandbox",
        path: "/Users/greg/Library/Mobile Documents/com~apple~CloudDocs/Engineering/clients/acme-corporation/repositories/daintree-monorepo-integration-sandbox",
        remotes: [
          ORIGIN,
          UPSTREAM,
          {
            name: "backup",
            url: "ssh://git@git.internal.acme-corporation.example.com:2222/platform/tooling/daintree-monorepo-integration-sandbox.git",
          },
        ],
        lastOpenedAt: daysAgo(1),
      }),
      candidate({
        projectId: null,
        name: "daintree",
        path: "/Volumes/External SSD (Archive)/src/github.com/daintreehq/daintree",
        source: "on-disk",
        remotes: [
          UPSTREAM,
          {
            name: "mirror",
            url: "https://git.example.org/mirrors/github.com/daintreehq/daintree.git",
          },
        ],
        lastOpenedAt: daysAgo(40),
      }),
      candidate({
        projectId: "c",
        name: "daintree",
        path: "/Users/greg/Projects/forks/experimental-branches/daintree-with-a-very-long-folder-name-that-will-not-fit",
        remotes: [
          {
            name: "origin",
            url: "git@gitlab.com:greg/experimental-branches/daintree-with-a-very-long-folder-name.git",
          },
          { name: "personal", url: "git@codeberg.org:greg/daintree.git" },
        ],
        matchedBy: "committed-id",
        lastOpenedAt: null,
      }),
    ],
  },
  "single-registered": {
    sourceRemotes: [ORIGIN],
    candidates: [candidate({ remotes: [ORIGIN] })],
  },
  "single-on-disk": {
    sourceRemotes: [ORIGIN],
    candidates: [
      candidate({
        projectId: null,
        path: "/Users/greg/src/github.com/gpriday/daintree",
        source: "on-disk",
        remotes: [ORIGIN],
        lastOpenedAt: daysAgo(3),
      }),
    ],
  },
  "single-committed-id": {
    sourceRemotes: [ORIGIN, UPSTREAM],
    candidates: [
      candidate({
        name: "daintree-experiments",
        path: "/Users/greg/Projects/forks/daintree-experiments",
        remotes: [{ name: "origin", url: "git@gitlab.com:greg/daintree-experiments.git" }],
        matchedBy: "committed-id",
        lastOpenedAt: daysAgo(64),
      }),
    ],
  },
};

installPreviewShims();
applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";

function Preview({ state }: { state: MatchState }) {
  const [selected, setSelected] = useState(state.selected ?? 0);
  const candidate = state.candidates[selected];
  return (
    <AppDialog isOpen onClose={() => {}} size="md" initialFocus="none">
      <AppDialog.Header className="py-3">
        <AppDialog.Title icon={<Server className="h-4 w-4 text-text-secondary" />}>
          Open daintree on {HOST}
        </AppDialog.Title>
        <AppDialog.CloseButton />
      </AppDialog.Header>
      <div className="flex flex-col gap-4 px-6 py-4" data-preview-body>
        <div className="space-y-4">
          <ProjectMatchChooser
            hostName={HOST}
            candidates={state.candidates}
            sourceRemotes={state.sourceRemotes}
            selected={selected}
            onSelect={setSelected}
            disabled={busy}
          />
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <button
              type="button"
              className="text-xs text-text-secondary underline-offset-2 hover:underline"
            >
              Use another folder on {HOST}…
            </button>
            <button
              type="button"
              className="text-xs text-text-secondary underline-offset-2 hover:underline"
            >
              Clone a fresh copy instead
            </button>
          </div>
        </div>
      </div>
      <AppDialog.Footer>
        <div className="flex shrink-0 items-center gap-3">
          <Button variant="ghost">Switch host only</Button>
          <Button variant="contrast">
            {candidate?.source === "on-disk" ? "Use existing folder" : `Open on ${HOST}`}
          </Button>
        </div>
      </AppDialog.Footer>
    </AppDialog>
  );
}

const state = MATCH_STATES[stateName];
const root = createRoot(document.getElementById("root")!);
root.render(
  <StrictMode>
    <TooltipProvider>
      {state ? (
        <div data-preview-shell>
          <Preview state={state} />
        </div>
      ) : (
        <p>Unknown state {stateName}</p>
      )}
    </TooltipProvider>
  </StrictMode>
);
