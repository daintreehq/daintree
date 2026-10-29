// @vitest-environment jsdom
/**
 * The New Worktree issue field for an issues provider with no `issueSelector`
 * slot (#13745): the host's own field, opening the same `listIssues`-backed
 * picker the worktree card's "Attach issue…" uses.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent, act } from "@testing-library/react";
import type { ReactNode } from "react";
import type { Issue } from "@shared/types/forge";

interface PickerProps {
  isOpen: boolean;
  onClose: () => void;
  worktree: { path: string; issueProviderId?: string; issueKey?: string };
  currentIssueNumber?: number;
  onAttach: (issue: Issue) => void;
  onDetach: () => void;
  zIndex?: string;
  draft?: boolean;
}

let lastPickerProps: PickerProps | null = null;
let slotView: (() => null) | null = null;

vi.mock("../../IssuePickerDialog", () => ({
  IssuePickerDialog: (props: PickerProps) => {
    lastPickerProps = props;
    return props.isOpen ? <div data-testid="issue-picker" /> : null;
  },
}));

vi.mock("@/registry/builtinRendererRegistry", () => ({
  useBuiltinView: (id: string) => (id === "tracker.issueSelector" ? slotView : null),
}));

let issuesSlots: Record<string, string> = {};
vi.mock("@/hooks/useResolvedForgeProvider", () => ({
  useResolvedForgeProvider: () => ({
    issues: {
      entry: { pluginId: "daintree.linear", contribution: { id: "linear", slots: issuesSlots } },
      providerId: "daintree.linear.linear",
    },
  }),
}));

vi.mock("@/store/projectStore", () => ({
  useProjectStore: (sel: (s: { currentProject: { id: string } }) => unknown) =>
    sel({ currentProject: { id: "proj" } }),
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));

import { IssueLinkerView } from "../IssueSelectorView";
import { PickerChevron } from "@/components/ui/PickerChevron";

const ISSUE: Issue = {
  number: 42,
  title: "Fix the thing",
  body: "",
  state: "open",
  rawState: "In Progress",
  url: "https://linear.app/acme/issue/ENG-42",
  assignees: [],
  labels: [],
  createdAt: 0,
  updatedAt: 0,
  id: "uuid-42",
  key: "ENG-42",
  providerId: "daintree.linear.linear",
  rawData: null,
};

async function flushLazy(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  lastPickerProps = null;
  slotView = null;
  issuesSlots = {};
});

afterEach(() => {
  cleanup();
});

describe("IssueLinkerView host fallback", () => {
  it("opens the host picker above the form, for this project", async () => {
    const onSelect = vi.fn();
    const { getByRole, queryByTestId, findByTestId } = render(
      <IssueLinkerView projectPath="/proj" selectedIssue={null} onSelectIssue={onSelect} />
    );
    expect(queryByTestId("issue-picker")).toBeNull();

    fireEvent.click(getByRole("button", { name: /Select an issue/ }));
    await flushLazy();
    await findByTestId("issue-picker");

    expect(lastPickerProps?.zIndex).toBe("nested");
    expect(lastPickerProps?.draft).toBe(true);
    expect(lastPickerProps?.worktree.path).toBe("/proj");
    expect(lastPickerProps?.currentIssueNumber).toBeUndefined();

    act(() => lastPickerProps?.onAttach(ISSUE));
    expect(onSelect).toHaveBeenCalledWith(ISSUE);
  });

  it("shows a picked issue by its key and hands the link to the picker", async () => {
    const onSelect = vi.fn();
    const { getByRole } = render(
      <IssueLinkerView projectPath="/proj" selectedIssue={ISSUE} onSelectIssue={onSelect} />
    );
    const trigger = getByRole("button", { name: "Issue ENG-42 Fix the thing" });
    expect(trigger.textContent).toContain("ENG-42 Fix the thing");

    fireEvent.click(trigger);
    await flushLazy();
    expect(lastPickerProps?.currentIssueNumber).toBe(42);
    expect(lastPickerProps?.worktree).toEqual({
      path: "/proj",
      issueProviderId: "daintree.linear.linear",
      issueKey: "ENG-42",
    });

    act(() => lastPickerProps?.onDetach());
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it("clears the selection and keeps focus on the field", () => {
    const onSelect = vi.fn();
    const { getByRole } = render(
      <IssueLinkerView projectPath="/proj" selectedIssue={ISSUE} onSelectIssue={onSelect} />
    );
    fireEvent.click(getByRole("button", { name: "Clear the linked issue" }));
    expect(onSelect).toHaveBeenCalledWith(null);
    expect(document.activeElement).toBe(getByRole("button", { name: /Issue ENG-42/ }));
  });

  it("falls back to #number for a provider with no display key", () => {
    const { key: _key, ...withoutKey } = ISSUE;
    const { getByRole } = render(
      <IssueLinkerView projectPath="/proj" selectedIssue={withoutKey} onSelectIssue={vi.fn()} />
    );
    expect(getByRole("button", { name: "Issue #42 Fix the thing" })).toBeTruthy();
  });

  it("ends in the chevron every other picker on the form draws", () => {
    const shared = render(<PickerChevron />);
    const expected = shared.container.querySelector("svg")!.getAttribute("class");
    shared.unmount();

    const { getByRole } = render(
      <IssueLinkerView projectPath="/proj" selectedIssue={null} onSelectIssue={vi.fn()} />
    );
    const svgs = getByRole("button", { name: /Select an issue/ }).querySelectorAll("svg");
    expect(svgs[svgs.length - 1]!.getAttribute("class")).toBe(expected);
  });

  it("defers to the provider's own selector when it contributes one", () => {
    issuesSlots = { issueSelector: "tracker.issueSelector" };
    slotView = () => null;
    const { queryByRole } = render(
      <IssueLinkerView projectPath="/proj" selectedIssue={null} onSelectIssue={vi.fn()} />
    );
    expect(queryByRole("button", { name: /Select an issue/ })).toBeNull();
  });

  it("tells the form while its picker owns the keyboard", async () => {
    const onPickerOpenChange = vi.fn();
    const { getByRole } = render(
      <IssueLinkerView
        projectPath="/proj"
        selectedIssue={null}
        onSelectIssue={vi.fn()}
        onPickerOpenChange={onPickerOpenChange}
      />
    );
    fireEvent.click(getByRole("button", { name: /Select an issue/ }));
    await flushLazy();
    expect(onPickerOpenChange).toHaveBeenLastCalledWith(true);

    act(() => lastPickerProps?.onClose());
    expect(onPickerOpenChange).toHaveBeenLastCalledWith(false);
  });
});
