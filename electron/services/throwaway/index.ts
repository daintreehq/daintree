import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import {
  HOST_THROWAWAY_DIR_NAME,
  HOST_THROWAWAY_WORKSPACE_ID,
} from "../../../shared/config/hostThrowaway.js";
import { MCP_RESPONSE_TEXT_MAX_BYTES } from "../../../shared/config/mcpLimits.js";
import { readTailSnapshot, tailCapturedOutput } from "../../../shared/utils/artifactParser.js";
import { fitTerminalOutputResult } from "../../../shared/utils/terminalOutputBudget.js";
import { registerRemoteService } from "../../remote/runtime.js";
import { createLogger } from "../../utils/logger.js";
import type {
  HostThrowawayExecutor,
  HostThrowawayOwner,
} from "../../remote/assistant/throwawayRelay.js";
import { HostThrowawayRuns, type HostThrowawayRunsDeps } from "./HostThrowawayRuns.js";

export {
  HostThrowawayRuns,
  type HostThrowawayCloseReason,
  type HostThrowawayOwner,
  type HostThrowawayRunEntry,
} from "./HostThrowawayRuns.js";

const logger = createLogger("main:HostThrowawayRuns");

/** The one folder every throwaway run starts in. */
export function hostThrowawayFolder(): string {
  return path.join(app.getPath("userData"), HOST_THROWAWAY_DIR_NAME);
}

/** The deps the runs use in the app, each service loaded on first use. */
export function liveHostThrowawayDeps(): HostThrowawayRunsDeps {
  const pty = () => import("../../window/serviceRefs.js").then((m) => m.getPtyClient());
  return {
    now: Date.now,
    newId: randomUUID,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    schedule: (ms, fire) => {
      const timer = setTimeout(fire, ms);
      timer.unref();
      return () => clearTimeout(timer);
    },
    // Ids and the reason only: never a screen, a command or a prompt.
    logClosed: ({ runId, agentId, owner, reason, ageMs, state }) => {
      logger.info("Closed a throwaway run", {
        runId,
        agentId,
        senderId: owner.senderId,
        helpSessionId: owner.helpSessionId,
        reason,
        ageMs,
        state,
      });
    },
    isLaunchable: async (agentId) => {
      const [
        { isEffectivelyRegisteredAgent },
        { isAgentLaunchable },
        { getCliAvailabilityServiceRef },
      ] = await Promise.all([
        import("../../../shared/config/agentRegistry.js"),
        import("../../../shared/utils/agentAvailability.js"),
        import("../../window/serviceRefs.js"),
      ]);
      if (!isEffectivelyRegisteredAgent(agentId)) return false;
      const service = getCliAvailabilityServiceRef();
      if (!service) return false;
      const availability = service.getAvailability() ?? (await service.checkAvailability());
      return isAgentLaunchable(availability?.[agentId as keyof typeof availability] ?? undefined);
    },
    spawn: async ({ terminalId, agentId, cancelled }) => {
      const folder = hostThrowawayFolder();
      await mkdir(folder, { recursive: true });
      const [{ spawnAndConfirm }, { spawnHostAssistantLive }, client] = await Promise.all([
        import("../assistants/assistantLaunch.js"),
        import("../viewless/index.js"),
        pty(),
      ]);
      // Its time limit or owner may have ended it while this prepared.
      if (cancelled()) return false;
      // Launched as the global assistant is, with no view, under an id that is
      // no project, so no project's settings, presets or MCP servers reach it.
      return spawnAndConfirm(
        client,
        () =>
          spawnHostAssistantLive(
            { id: HOST_THROWAWAY_WORKSPACE_ID, path: folder },
            { terminalId, agentId, cwd: folder, env: {}, prompt: "", agentLaunchFlags: [] }
          ),
        terminalId,
        // Nothing waits on readiness after this, so a spawn that never reported didn't start.
        { unreportedStarted: false }
      );
    },
    readScreen: async (terminalId, maxLines) => {
      const client = await pty();
      if (!client) return null;
      const snapshot = await readTailSnapshot(
        (options) => client.getSerializedStateAsync(terminalId, options),
        maxLines
      );
      if (snapshot === null) return null;
      return fitTerminalOutputResult(
        tailCapturedOutput(snapshot.data, maxLines, true),
        MCP_RESPONSE_TEXT_MAX_BYTES
      );
    },
    submit: async (terminalId, command) => {
      const [{ invokeHostChannel }, { CHANNELS }] = await Promise.all([
        import("../viewless/viewlessInvoke.js"),
        import("../../ipc/channels.js"),
      ]);
      await invokeHostChannel<void>(HOST_THROWAWAY_WORKSPACE_ID, CHANNELS.TERMINAL_SUBMIT, [
        terminalId,
        command,
        randomUUID(),
      ]);
    },
    write: async (terminalId, data) => {
      const client = await pty();
      if (!client) throw new Error("Terminal service is not available");
      client.write(terminalId, data);
    },
    kill: (terminalId) => {
      void pty()
        .then((client) => client?.kill(terminalId, "throwaway-closed"))
        .catch((error: unknown) => {
          logger.warn("Couldn't end a throwaway run's process", { terminalId, error });
        });
    },
  };
}

let instance: HostThrowawayRuns | null = null;
let creating: Promise<HostThrowawayRuns> | null = null;

/** The host's throwaway runs, created on the first throwaway call with its exit listener in place. */
export function getHostThrowawayRuns(): Promise<HostThrowawayRuns> {
  creating ??= import("../../window/serviceRefs.js").then(({ getPtyClient }) => {
    const runs = new HostThrowawayRuns(liveHostThrowawayDeps());
    const client = getPtyClient();
    client?.on("exit", (id: string) => runs.handleExit(id));
    // A pty-host crash never brings a run back (#14447): its terminal is dropped, not replayed.
    client?.on("terminal-lost", (id: string) => runs.handleLost(id));
    client?.on("host-crash", () => runs.handleHostLost());
    instance = runs;
    return runs;
  });
  return creating;
}

/** The runs, when any throwaway call created them; teardown must not create them just to end them. */
export function peekHostThrowawayRuns(): HostThrowawayRuns | null {
  return instance;
}

/**
 * Offers this machine's throwaway runs to the relays (#14446), loading them on
 * the first call. The returned teardown ends every run, since no caller could
 * reach one again, including a launch whose runs were still loading.
 */
export function registerHostThrowawayRuns(): () => void {
  let offered = true;
  // Calls waiting for the runs to load, so an owner that goes meanwhile launches nothing.
  const loading = new Set<{ owner: HostThrowawayOwner; ended: boolean }>();
  const executor: HostThrowawayExecutor = {
    run: async (owner, call, options) => {
      const waiting = { owner, ended: false };
      loading.add(waiting);
      try {
        const runs = await getHostThrowawayRuns();
        if (!offered) return { status: "refused", reason: "throwaway-off" };
        if (waiting.ended) {
          return {
            status: "failed",
            reason: call.tool === "throwaway.launch" ? "launch-failed" : "not-found",
          };
        }
        // Held until the runs have the call, so an end landing in between still reaches it.
        const running = runs.run(owner, call, options);
        loading.delete(waiting);
        return await running;
      } finally {
        loading.delete(waiting);
      }
    },
    endOwner: (owner, reason) => {
      for (const waiting of loading) {
        if (
          waiting.owner.senderId === owner.senderId &&
          (owner.helpSessionId === undefined || waiting.owner.helpSessionId === owner.helpSessionId)
        ) {
          waiting.ended = true;
        }
      }
      instance?.endOwner(owner, reason);
    },
  };
  const unregister = registerRemoteService("hostThrowawayRuns", executor);
  return () => {
    offered = false;
    unregister();
    instance?.endAll();
  };
}
