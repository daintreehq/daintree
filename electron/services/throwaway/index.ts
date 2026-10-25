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
import { HostThrowawayRuns, type HostThrowawayRunsDeps } from "./HostThrowawayRuns.js";

export {
  HostThrowawayRuns,
  type HostThrowawayOwner,
  type HostThrowawayRunEntry,
} from "./HostThrowawayRuns.js";

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
    spawn: async ({ terminalId, agentId }) => {
      const folder = hostThrowawayFolder();
      await mkdir(folder, { recursive: true });
      const [{ spawnAndConfirm }, { spawnHostAssistantLive }, client] = await Promise.all([
        import("../assistants/assistantLaunch.js"),
        import("../viewless/index.js"),
        pty(),
      ]);
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
      void pty().then((client) => client?.kill(terminalId, "throwaway-closed"));
    },
  };
}

let instance: HostThrowawayRuns | null = null;
let creating: Promise<HostThrowawayRuns> | null = null;

/** The host's throwaway runs, created on the first throwaway call with its exit listener in place. */
export function getHostThrowawayRuns(): Promise<HostThrowawayRuns> {
  creating ??= import("../../window/serviceRefs.js").then(({ getPtyClient }) => {
    const runs = new HostThrowawayRuns(liveHostThrowawayDeps());
    getPtyClient()?.on("exit", (id: string) => runs.handleExit(id));
    instance = runs;
    return runs;
  });
  return creating;
}

/** The runs, when any throwaway call created them; teardown must not create them just to end them. */
export function peekHostThrowawayRuns(): HostThrowawayRuns | null {
  return instance;
}
