import { MockLines, MockSpotlight, reveal } from "@daintreehq/tour/kit";
import { MockApp, MockGrid, MockPane, MockWorktreeCard } from "@daintreehq/tour/mock-app";
import { useCue } from "@daintreehq/tour/react";
import type { ReactElement } from "react";

/**
 * The welcome tour's scenes, one per chapter in tours/welcome.narration.json.
 * Every beat waits on a cue from the narration, never a timer, so the scene
 * keeps pace with the voice or, until the tour is voiced, the silent clock.
 */

const ROWS = [
  { title: "Add dark mode to the invoice page", status: "Open" },
  { title: "Export customers as CSV", status: "In progress" },
  { title: "Write the onboarding checklist", status: "Open" },
];

function Worktrees(): ReactElement {
  return <MockWorktreeCard name="request-desk" branch="main" selected />;
}

function RequestList({ added }: { added: boolean }): ReactElement {
  const rows = added ? ROWS : ROWS.slice(0, 2);
  return (
    <div
      className="flex h-full flex-col gap-1.5 rounded-lg border border-border-default bg-surface-panel p-2.5"
      data-tour-anchor="requests-list"
    >
      <div className="text-2xs font-semibold text-text-primary">Request Desk</div>
      <ul className="flex flex-col gap-1">
        {rows.map((row, index) => (
          <li
            key={row.title}
            className={`flex justify-between rounded-md px-1.5 py-1 text-2xs text-text-secondary ${
              index === 2 ? reveal(added) : ""
            }`}
          >
            <span>{row.title}</span>
            <span className="text-text-muted">{row.status}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Requests(): ReactElement {
  const list = useCue("list");
  const tools = useCue("tools");
  return (
    <MockApp
      focus={list ? ["grid"] : undefined}
      worktrees={<Worktrees />}
      grid={
        <MockGrid columns={2}>
          <RequestList added={tools} />
          <MockPane agent={{ id: "claude", name: "Claude", Icon: null }}>
            <MockLines widths={tools ? [80, 64, 72] : [80, 40]} />
          </MockPane>
        </MockGrid>
      }
    >
      <MockSpotlight targets={["requests-list"]} visible={list && !tools} />
    </MockApp>
  );
}

function Reports(): ReactElement {
  const report = useCue("report");
  const preview = useCue("preview");
  return (
    <MockApp
      focus={["grid"]}
      worktrees={<Worktrees />}
      grid={
        <MockGrid columns={1}>
          <div className="flex h-full flex-col justify-center gap-2 rounded-lg border border-border-default bg-surface-panel p-4">
            <div className="text-2xs font-semibold text-text-primary">Reports</div>
            <div className={`text-2xs text-text-secondary ${reveal(report)}`}>
              {preview ? "Ready · 3 requests" : "Building…"}
            </div>
            <div
              data-tour-anchor="report-preview"
              className={`h-16 w-28 rounded-md border border-border-default bg-surface-panel-elevated ${reveal(preview)}`}
            />
          </div>
        </MockGrid>
      }
    >
      <MockSpotlight targets={["report-preview"]} visible={preview} />
    </MockApp>
  );
}

export default {
  scenes: { requests: Requests, reports: Reports },
  chapterTitles: { requests: "Requests beside your agents", reports: "Reports in the background" },
};
