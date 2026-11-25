import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { AppError } from "../../utils/errorTypes.js";
import { getCliAvailabilityServiceRef, getPtyClient } from "../../window/serviceRefs.js";
import {
  beginWatchRequest,
  resizeWatchedTerminal,
  stopTerminalWatch,
  stopTerminalWatchById,
  watchedTerminal,
  watchTerminal,
} from "../../ipc/handlers/canopyTerminalWatch.js";
import type { HostSignInDeps } from "./hostSignIn.js";

/**
 * The folder every sign-in starts in, the same one each time and no project's:
 * a CLI opened as it is (no sign-in command of its own) trusts, indexes or
 * offers to set up this empty folder rather than the person's home.
 */
export const HOST_SIGN_IN_DIR_NAME = "agent-sign-in";

/** What a sign-in's terminal opens at, before its dialog sizes it. */
const START_COLS = 80;
const START_ROWS = 24;

type Dialect = "posix" | "windows";

/**
 * The agent's own sign-in command line as the host's shell reads it: the copy
 * of the CLI its launches start, then its declared sign-in arguments. An
 * agent that declares none opens as it is.
 */
export function agentSignInCommand(
  baseCommand: string,
  signInArgs: readonly string[] | undefined,
  dialect: Dialect,
  quote: (arg: string, dialect: Dialect) => string
): string {
  return [baseCommand, ...(signInArgs ?? []).map((arg) => quote(arg, dialect))].join(" ");
}

function requirePtyClient() {
  const client = getPtyClient();
  if (!client) {
    throw new AppError({
      code: "INTERNAL",
      message: "The terminal service isn't running",
      userMessage: "This host's terminals aren't available right now.",
    });
  }
  return client;
}

/**
 * The deps a host's sign-ins use in the app; the launch helpers load on the
 * first sign-in. None of their failures is UNSUPPORTED, which a Shell reads as
 * a host too old to have sign-ins at all.
 */
export function liveHostSignInDeps(): HostSignInDeps {
  return {
    newId: randomUUID,
    spawn: async ({ terminalId, agentId }) => {
      const [
        { getEffectiveAgentConfig },
        { resolveAgentLaunchBaseCommandFor },
        { quoteLaunchArgOptional },
        { buildCommandLaunchShell },
        { spawnAndConfirm },
      ] = await Promise.all([
        import("../../../shared/config/agentRegistry.js"),
        import("../../../shared/utils/agentLaunchCommand.js"),
        import("../../../shared/utils/shellEscape.js"),
        import("../../ipc/handlers/terminal/commandLaunch.js"),
        import("../../services/assistants/assistantLaunch.js"),
      ]);
      const config = getEffectiveAgentConfig(agentId);
      if (!config) {
        throw new AppError({
          code: "NOT_FOUND",
          message: `No agent "${agentId}" on this host`,
          userMessage: "This host doesn't know that agent.",
        });
      }
      const client = requirePtyClient();
      const dialect: Dialect = process.platform === "win32" ? "windows" : "posix";
      const detail = getCliAvailabilityServiceRef()?.getDetails()?.[agentId];
      const command = agentSignInCommand(
        resolveAgentLaunchBaseCommandFor(config.command, detail, dialect, undefined),
        config.signInArgs,
        dialect,
        quoteLaunchArgOptional
      );
      // `exit`, so the terminal ends with the sign-in rather than leaving a
      // shell on the host behind it. A login shell the wrapper can't drive
      // (fish) hands it to `sh`, which reads no rc file but gets main's PATH,
      // read from the login shell, and the copy launches start.
      const launch =
        buildCommandLaunchShell(command, undefined, "exit") ??
        (dialect === "posix" ? buildCommandLaunchShell(command, "/bin/sh", "exit") : null);
      if (!launch) {
        throw new AppError({
          code: "INTERNAL",
          message: "No shell here can run the sign-in command",
          userMessage: `${config.name}'s sign-in can't run in this host's shell.`,
        });
      }
      const { app } = await import("electron");
      const cwd = path.join(app.getPath("userData"), HOST_SIGN_IN_DIR_NAME);
      await mkdir(cwd, { recursive: true });
      const started = await spawnAndConfirm(
        client,
        async () => {
          client.spawn(terminalId, {
            cwd,
            shell: launch.shell,
            args: launch.args,
            cols: START_COLS,
            rows: START_ROWS,
            kind: "terminal",
            title: `Sign in to ${config.name}`,
            restore: false,
            // Placed in no project on purpose: no project's settings, lease or
            // sweep reaches it, and no window's grid lists it.
            projectId: null,
          });
          return true;
        },
        terminalId,
        { unreportedStarted: false }
      );
      if (!started) {
        throw new AppError({
          code: "INTERNAL",
          message: "The sign-in terminal didn't start",
          userMessage: `${config.name}'s sign-in didn't start on this host.`,
        });
      }
      const record = await client.getTerminalAsync(terminalId).catch(() => null);
      return { spawnedAt: record?.spawnedAt ?? Date.now() };
    },
    kill: (terminalId) => {
      getPtyClient()?.kill(terminalId, "sign-in-closed");
    },
    watch: async (target, terminalId, spawnedAt, ended, onEnded) => {
      const client = requirePtyClient();
      const view = await watchTerminal(
        client,
        target,
        terminalId,
        spawnedAt,
        beginWatchRequest(target.id),
        client.getLiveGeneration(terminalId),
        // Its dialog is the only surface that shows it, so the dialog sizes it.
        () => true,
        // Bound like an assistant's stream, so turning Canopy off, which ends
        // the worker streams it opened, never ends a sign-in.
        { isBound: () => !ended(), onEnded, mayType: () => true },
        true
      );
      return view.watchId === null ? view : { ...view, holdsSize: true };
    },
    watched: (target, watchId) => watchedTerminal(target.id, watchId)?.runId ?? null,
    write: (terminalId, data) => requirePtyClient().write(terminalId, data),
    resize: (target, watchId, cols, rows) => {
      try {
        resizeWatchedTerminal(requirePtyClient(), target.id, watchId, cols, rows);
      } catch {
        // A measure outside what a PTY takes, mid-layout: the dialog measures again.
      }
    },
    unwatch: (target, watchId) => stopTerminalWatchById(target.id, watchId),
    release: (target) => stopTerminalWatch(target.id),
  };
}
