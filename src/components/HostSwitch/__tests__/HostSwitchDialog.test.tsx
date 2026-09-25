/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  HostSwitchExecutePayload,
  HostSwitchExecuteResult,
  HostSwitchPreparation,
} from "@shared/types/ipc/hostSwitch";

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/AppDialog", () => {
  const AppDialog = ({ isOpen, children }: { isOpen: boolean; children: ReactNode }) =>
    isOpen ? <div data-testid="app-dialog">{children}</div> : null;
  AppDialog.Header = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  AppDialog.Title = ({ children }: { children: ReactNode }) => <h2>{children}</h2>;
  AppDialog.CloseButton = () => <button type="button">close</button>;
  AppDialog.Footer = ({ children, hint }: { children: ReactNode; hint?: ReactNode }) => (
    <div>
      <div data-testid="hint">{hint}</div>
      {children}
    </div>
  );
  return { AppDialog };
});

vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/Hosts/hostList", () => ({
  useHostList: () => ({
    hosts: [{ descriptor: { id: "studio-01", name: "studio-01" } }],
    localSummary: null,
  }),
}));

const switchToHost = vi.fn<(...args: unknown[]) => Promise<void>>(async () => {});
vi.mock("@/components/Hosts/hostSwitching", () => ({
  switchToHost: (...args: unknown[]) => switchToHost(...args),
}));

import { HostSwitchDialog } from "../HostSwitchDialog";

function preparation(overrides: Partial<HostSwitchPreparation> = {}): HostSwitchPreparation {
  return {
    fromHostId: "local",
    toHostId: "studio-01",
    projectId: "p1",
    projectName: "daintree",
    worktreePath: "/Users/greg/Projects/daintree",
    branch: "feature/host-chip",
    branchCheck: { kind: "same-tip", remote: "origin", sha: "abc" },
    remoteBranch: "feature/host-chip",
    cloneUrl: "git@github.com:daintreehq/daintree.git",
    hasUncommittedChanges: true,
    unpushedCommits: [],
    remotes: [{ name: "origin", url: "git@github.com:daintreehq/daintree.git" }],
    committedProjectId: null,
    candidates: [],
    destination: {
      path: "/home/greg/Projects/daintree",
      status: "free",
      detail: null,
      suggestion: null,
    },
    usesLfs: false,
    hasSubmodules: false,
    targetGitLfsAvailable: true,
    recipes: [],
    defaultRecipeId: null,
    ...overrides,
  };
}

const prepare = vi.fn();
const execute = vi.fn<(payload: HostSwitchExecutePayload) => Promise<HostSwitchExecuteResult>>();
const checkDestination = vi.fn(async ({ path }: { path: string }) => ({
  path,
  status: "free" as const,
  detail: null,
  suggestion: null,
}));

const request = { id: 1, toHostId: "studio-01", projectId: "p1", worktreePath: null };

beforeEach(() => {
  switchToHost.mockClear();
  prepare.mockReset();
  execute.mockReset();
  Object.assign(window, {
    electron: {
      hostSwitch: {
        prepare,
        execute,
        checkDestination,
        status: vi.fn(async () => ({ state: "running" })),
        cancel: vi.fn(async () => true),
      },
    },
  });
});

describe("HostSwitchDialog", () => {
  it("offers the clone with the branch line and keeps uncommitted changes informational", async () => {
    prepare.mockResolvedValue(preparation());
    render(<HostSwitchDialog request={request} onClose={() => {}} />);
    expect(await screen.findByText("daintree isn't on studio-01 yet")).toBeTruthy();
    expect(screen.getByText("On origin at the same commit")).toBeTruthy();
    expect(screen.getByText(/^Uncommitted changes on .+ stay there\.$/)).toBeTruthy();
    expect(execute).not.toHaveBeenCalled();
  });

  it("shows git's words and the host's own fix when the host can't clone", async () => {
    prepare.mockResolvedValue(preparation());
    execute.mockResolvedValue({
      kind: "git-failed",
      step: "clone",
      hostId: "studio-01",
      reason: "auth-failed",
      message: "Permission denied (publickey).",
    });
    const onClose = vi.fn();
    render(<HostSwitchDialog request={request} onClose={onClose} />);
    fireEvent.click(await screen.findByRole("button", { name: "Clone and open" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      "studio-01 couldn't clone git@github.com:daintreehq/daintree.git"
    );
    expect(alert.textContent).toContain("Permission denied (publickey).");
    expect(alert.textContent).toContain("connect GitHub on studio-01");
    expect(onClose).not.toHaveBeenCalled();
    expect(switchToHost).not.toHaveBeenCalled();
  });

  it("switches into the cloned project once the host reports it open", async () => {
    prepare.mockResolvedValue(preparation());
    execute.mockResolvedValue({
      kind: "opened",
      hostId: "studio-01",
      projectId: "host-p9",
      projectPath: "/home/greg/Projects/daintree",
      projectName: "daintree",
      worktreePath: "/home/greg/Projects/daintree-worktrees/feature-host-chip",
      canCheckOutBranch: false,
      branchNote: null,
      setupRecipeId: null,
    });
    const onClose = vi.fn();
    render(<HostSwitchDialog request={request} onClose={onClose} />);
    fireEvent.click(await screen.findByRole("button", { name: "Clone and open" }));
    await waitFor(() => expect(switchToHost).toHaveBeenCalledWith("studio-01", false, "host-p9"));
    expect(onClose).toHaveBeenCalled();
    expect(execute.mock.calls[0]![0]).toMatchObject({
      kind: "clone",
      source: { kind: "remote", url: "git@github.com:daintreehq/daintree.git" },
      destination: "/home/greg/Projects/daintree",
      branch: { name: "feature/host-chip", remoteBranch: "feature/host-chip" },
    });
  });

  it("pushes only when chosen, shows what it publishes, and a refused push keeps the dialog and clones nothing", async () => {
    prepare.mockResolvedValue(
      preparation({
        branchCheck: { kind: "ahead", remote: "origin", ahead: 1 },
        unpushedCommits: [{ sha: "abc1234", subject: "Draw the host chip" }],
      })
    );
    execute.mockResolvedValue({
      kind: "git-failed",
      step: "push",
      hostId: "local",
      reason: "push-rejected-outdated",
      message: "! [rejected] feature/host-chip (fetch first)",
    });
    render(<HostSwitchDialog request={request} onClose={() => {}} />);
    expect(await screen.findByRole("button", { name: "Clone and open" })).toBeTruthy();
    expect(screen.queryByText("Draw the host chip")).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Push, then continue" }));
    expect(screen.getByText("Draw the host chip")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Push, then clone" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("[rejected]");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]![0]).toMatchObject({ kind: "push", remote: "origin" });
  });

  it("opens the host's own copy when it already has the project", async () => {
    prepare.mockResolvedValue(
      preparation({
        candidates: [
          {
            projectId: "host-p1",
            path: "/home/greg/code/daintree",
            name: "daintree",
            remotes: [{ name: "origin", url: "https://github.com/daintreehq/daintree" }],
            source: "registered",
            matchedBy: "remote-url",
            lastOpenedAt: null,
          },
        ],
      })
    );
    execute.mockResolvedValue({
      kind: "opened",
      hostId: "studio-01",
      projectId: "host-p1",
      projectPath: "/home/greg/code/daintree",
      projectName: "daintree",
      worktreePath: "/home/greg/code/daintree-worktrees/feature-host-chip",
      canCheckOutBranch: false,
      branchNote: null,
      setupRecipeId: null,
    });
    render(<HostSwitchDialog request={request} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open on studio-01" }));
    await waitFor(() => expect(switchToHost).toHaveBeenCalledWith("studio-01", false, "host-p1"));
    expect(execute.mock.calls[0]![0]).toMatchObject({
      kind: "open",
      candidate: { projectId: "host-p1" },
    });
  });

  it("just switches host without touching the project", async () => {
    prepare.mockResolvedValue(preparation());
    render(<HostSwitchDialog request={request} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Just switch host" }));
    expect(switchToHost).toHaveBeenCalledWith("studio-01", false);
    expect(execute).not.toHaveBeenCalled();
  });

  it("offers a copy of a repository with no remote, saying what it leaves behind", async () => {
    prepare.mockResolvedValue(preparation({ remotes: [], cloneUrl: null }));
    render(<HostSwitchDialog request={request} onClose={() => {}} />);
    expect(
      await screen.findByRole("button", { name: "Send a copy of the repository" })
    ).toBeTruthy();
    expect(screen.getByText(/committed history only/)).toBeTruthy();
  });
});

describe("HostSwitchDialog destination", () => {
  it("won't clone into a folder checked for an earlier input", async () => {
    prepare.mockResolvedValue(preparation());
    render(<HostSwitchDialog request={request} onClose={() => {}} />);
    const button = await screen.findByRole("button", { name: "Clone and open" });
    expect(button.hasAttribute("disabled")).toBe(false);
    fireEvent.change(screen.getByLabelText("Folder on studio-01"), {
      target: { value: "/home/greg/elsewhere" },
    });
    expect(button.hasAttribute("disabled")).toBe(true);
    fireEvent.click(button);
    expect(execute).not.toHaveBeenCalled();
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
  });
});
