import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
import type { Issue } from "@shared/types/forge";

/**
 * The one bridge call `IssuePickerDialog` makes, answered from fixtures.
 *
 * `forge.listIssues` filters by the dialog's own `state` and `search` options,
 * so the filter pills and the search field drive real re-fetches rather than a
 * canned frame per state.
 *
 * Query parameters:
 *   ?outcome=ok|empty|hang|error   what every `listIssues` call does
 *
 * With `outcome=error`, `window.__issueShot.recover()` makes the next call
 * succeed, so a spec can photograph a retry landing.
 */

const params = new URLSearchParams(window.location.search);
let outcome = params.get("outcome") ?? "ok";

const MIN = 60_000;
/** A real IPC round trip still resolves on a later tick. */
const ROUND_TRIP_MS = 40;

function issue(number: number, title: string, over: Partial<Issue> = {}): Issue {
  const updatedAt = Date.now() - (12_000 - number) * MIN;
  return {
    number,
    title,
    body: "",
    state: "open",
    rawState: "OPEN",
    url: `https://github.com/helios-labs/helios-dashboard/issues/${number}`,
    author: { login: "mira-okafor", avatarUrl: "" },
    assignees: [],
    labels: [],
    commentCount: 0,
    createdAt: updatedAt,
    updatedAt,
    rawData: {},
    ...over,
  };
}

const closed = { state: "closed", rawState: "CLOSED" } as const;

export const ISSUES: Issue[] = [
  issue(11958, "Restart into a scratch workspace restores an unnamed project shell"),
  issue(11957, "Cmd+Alt+I falls back to the fleet view in most projects"),
  issue(
    11949,
    "Show Claude Code subagents as inspectable child terminals with their own scrollback, status pip, and a jump-to-parent affordance"
  ),
  issue(11755, "Publish Daintree to winget"),
  issue(11745, "Bundle the assistant CLI into release builds"),
  issue(11244, "Fold the forge slot view seam into the panel contract"),
  issue(11210, "Renderer memory climbs to 3.2GB across a long session"),
  issue(11158, "Remote SSH workspace mode"),
  issue(11102, "Worktree dashboard drops the branch name when the path is a symlink", closed),
  issue(11090, "Theme picker previews flash the default palette on hover", closed),
  issue(10988, "Paste of a multi-line prompt loses the trailing newline", closed),
  issue(10954, "Settings search doesn't match keybinding descriptions", closed),
];

async function listIssues({ opts }: { cwd: string; opts?: { search?: string; state?: string } }) {
  await new Promise((resolve) => setTimeout(resolve, ROUND_TRIP_MS));
  if (outcome === "hang") await new Promise(() => undefined);
  if (outcome === "error") {
    throw new Error("GitHub didn't respond (502 Bad Gateway)");
  }
  if (outcome === "empty") return { items: [], nextCursor: null, hasMore: false, totalCount: 0 };
  const state = opts?.state ?? "open";
  const search = opts?.search?.toLowerCase() ?? "";
  const items = ISSUES.filter((i) => state === "all" || i.state === state).filter(
    (i) => !search || i.title.toLowerCase().includes(search) || String(i.number).includes(search)
  );
  return { items, nextCursor: null, hasMore: false, totalCount: items.length };
}

export const issueShot = {
  /** The last attach or detach the dialog reported. */
  last: null as string | null,
  recover() {
    outcome = "ok";
  },
};
Reflect.set(window, "__issueShot", issueShot);

installPreviewShims({
  forge: new Proxy(
    { listIssues },
    {
      get: (target, key) =>
        key in target ? Reflect.get(target, key) : () => Promise.resolve(undefined),
    }
  ),
});
