import type { ReactNode } from "react";
import type { SpawnError, TerminalRestartError, TerminalScrollbackRestoreError } from "@/types";
import { SpawnErrorBanner } from "../SpawnErrorBanner";
import { TerminalErrorBanner } from "../TerminalErrorBanner";
import { ScrollbackRestoreErrorBanner } from "../ScrollbackRestoreErrorBanner";
import { AgentCompletionBanner } from "../AgentCompletionBanner";
import { TerminalRestartStatusBanner } from "../TerminalRestartStatusBanner";
import { WorktreeMoveBanner } from "../WorktreeMoveBanner";

const noop = () => undefined;
const NOW = 1_758_600_000_000;

const LONG_CWD =
  "/Users/greg/Projects/Daintree/daintree-worktrees/feature-issue-12486-handback-marker-contract/packages/plugin-sdk/src/runtime";

const LONG_MESSAGE =
  "posix_spawnp failed: the shell exited during startup after sourcing ~/.zshrc (exit status 127: command not found: nvm). Output before exit: zsh: command not found: nvm; zsh: command not found: pyenv; compinit:503: no such file or directory: /opt/homebrew/share/zsh/site-functions/_brew_services";

function spawn(error: SpawnError, cwd?: string, isRestarting = false) {
  return (
    <SpawnErrorBanner
      terminalId="t1"
      error={error}
      cwd={cwd}
      onUpdateCwd={noop}
      onRetry={noop}
      onTrash={noop}
      isRestarting={isRestarting}
    />
  );
}

function restart(error: TerminalRestartError, isRestarting = false) {
  return (
    <TerminalErrorBanner
      terminalId="t1"
      error={error}
      onUpdateCwd={noop}
      onRetry={noop}
      onTrash={noop}
      isRestarting={isRestarting}
    />
  );
}

function scrollback(error: TerminalScrollbackRestoreError, isRestarting = false) {
  return (
    <ScrollbackRestoreErrorBanner
      terminalId="t1"
      error={error}
      onDismiss={noop}
      onRestart={noop}
      isRestarting={isRestarting}
    />
  );
}

const MOVE_DESTINATION = "/Users/greg/Projects/Daintree/daintree-worktrees/fix-sidebar-sync-signals";

export type BannerPlacement = "top" | "bottom";

export interface TerminalBannerFixture {
  name: string;
  group: "errors" | "status" | "move";
  what: string;
  placement: BannerPlacement;
  render: () => ReactNode;
}

export const TERMINAL_BANNER_FIXTURES: TerminalBannerFixture[] = [
  {
    name: "spawn-enoent",
    group: "errors",
    what: "spawn failed, shell not found, with diagnostics",
    placement: "top",
    render: () =>
      spawn(
        {
          code: "ENOENT",
          message: "spawn /usr/local/bin/fish ENOENT",
          errno: -2,
          syscall: "spawn /usr/local/bin/fish",
          path: "/usr/local/bin/fish",
        },
        "/Users/greg/Projects/daintree"
      ),
  },
  {
    name: "spawn-enotdir",
    group: "errors",
    what: "spawn failed, working directory invalid (long path)",
    placement: "top",
    render: () => spawn({ code: "ENOTDIR", message: "ENOTDIR", syscall: "chdir" }, LONG_CWD),
  },
  {
    name: "spawn-emfile",
    group: "errors",
    what: "spawn failed, resource limit",
    placement: "top",
    render: () => spawn({ code: "EMFILE", message: "EMFILE: too many open files" }),
  },
  {
    name: "spawn-unknown-long",
    group: "errors",
    what: "spawn failed, unknown, long message and path",
    placement: "top",
    render: () => spawn({ code: "UNKNOWN", message: LONG_MESSAGE, errno: 127 }, LONG_CWD),
  },
  {
    name: "spawn-restarting",
    group: "errors",
    what: "spawn failed, retry in flight",
    placement: "top",
    render: () =>
      spawn(
        {
          code: "ENOENT",
          message: "spawn /usr/local/bin/fish ENOENT",
          path: "/usr/local/bin/fish",
        },
        "/Users/greg/Projects/daintree",
        true
      ),
  },
  {
    name: "restart-error",
    group: "errors",
    what: "restart failed, generic",
    placement: "top",
    render: () =>
      restart({
        message: "The PTY host refused the restart: permission denied (EACCES)",
        code: "EACCES",
        timestamp: NOW,
        recoverable: false,
      }),
  },
  {
    name: "restart-cwd",
    group: "errors",
    what: "restart failed, directory gone (long path)",
    placement: "top",
    render: () =>
      restart({
        message: "Working directory no longer exists",
        code: "ENOENT",
        timestamp: NOW,
        recoverable: true,
        context: { failedCwd: LONG_CWD },
      }),
  },
  {
    name: "restart-long",
    group: "errors",
    what: "restart failed, long message",
    placement: "top",
    render: () =>
      restart({ message: LONG_MESSAGE, code: "EIO", timestamp: NOW, recoverable: false }),
  },
  {
    name: "restart-restarting",
    group: "errors",
    what: "restart failed, retry in flight",
    placement: "top",
    render: () =>
      restart(
        {
          message: "The PTY host refused the restart: permission denied (EACCES)",
          code: "EACCES",
          timestamp: NOW,
          recoverable: false,
        },
        true
      ),
  },
  {
    name: "exit-error",
    group: "errors",
    what: "session exited non-zero (sibling, single line)",
    placement: "top",
    render: () => (
      <TerminalRestartStatusBanner
        variant={{ type: "exit-error", exitCode: 137 }}
        onRestart={noop}
        onDismiss={noop}
      />
    ),
  },
  {
    name: "scrollback-timeout",
    group: "status",
    what: "scrollback restore timed out",
    placement: "top",
    render: () => scrollback({ type: "timeout", message: "write timeout", timestamp: NOW }),
  },
  {
    name: "scrollback-parse",
    group: "status",
    what: "scrollback restore parse failure",
    placement: "top",
    render: () => scrollback({ type: "parse", message: "unexpected byte", timestamp: NOW }),
  },
  {
    name: "scrollback-error-long",
    group: "status",
    what: "scrollback restore failed, long message",
    placement: "top",
    render: () =>
      scrollback({
        type: "error",
        message:
          "ENOENT: no such file or directory, open '/Users/greg/Library/Application Support/Daintree/terminal-sessions/7f3c2a1e-9b4d-4c8e-a6f1-2d9e8b7c6a5f.restore'",
        timestamp: NOW,
      }),
  },
  {
    name: "scrollback-restarting",
    group: "status",
    what: "scrollback restore failed, reset in flight",
    placement: "top",
    render: () => scrollback({ type: "timeout", message: "write timeout", timestamp: NOW }, true),
  },
  {
    name: "completion-count",
    group: "status",
    what: "agent finished, 3 files changed",
    placement: "bottom",
    render: () => <AgentCompletionBanner fileCount={3} onReview={noop} onDismiss={noop} />,
  },
  {
    name: "completion-one",
    group: "status",
    what: "agent finished, 1 file changed",
    placement: "bottom",
    render: () => <AgentCompletionBanner fileCount={1} onReview={noop} onDismiss={noop} />,
  },
  {
    name: "completion-generic",
    group: "status",
    what: "agent finished, count unknown",
    placement: "bottom",
    render: () => <AgentCompletionBanner onReview={noop} onDismiss={noop} />,
  },
  {
    name: "completion-relay",
    group: "status",
    what: "agent finished, assistant and agent relays available",
    placement: "bottom",
    render: () => (
      <AgentCompletionBanner
        fileCount={12}
        onReview={noop}
        onDismiss={noop}
        onSendToAssistant={noop}
        onSendToAgent={noop}
      />
    ),
  },
  {
    name: "move-tell",
    group: "move",
    what: "agent pane moved to another worktree, tell offered",
    placement: "top",
    render: () => (
      <WorktreeMoveBanner destinationPath={MOVE_DESTINATION} onTell={noop} onDismiss={noop} />
    ),
  },
  {
    name: "move-failed",
    group: "move",
    what: "agent pane moved, the tell did not reach the terminal",
    placement: "top",
    render: () => (
      <WorktreeMoveBanner
        destinationPath={MOVE_DESTINATION}
        deliveryFailed
        onTell={noop}
        onDismiss={noop}
      />
    ),
  },
  {
    name: "move-gone",
    group: "move",
    what: "agent pane moved, destination worktree since removed",
    placement: "top",
    render: () => <WorktreeMoveBanner destinationPath={undefined} onTell={noop} onDismiss={noop} />,
  },
];

export function requireTerminalBannerFixture(name: string): TerminalBannerFixture {
  const fixture = TERMINAL_BANNER_FIXTURES.find((f) => f.name === name);
  if (!fixture) throw new Error(`unknown terminal banner fixture "${name}"`);
  return fixture;
}
