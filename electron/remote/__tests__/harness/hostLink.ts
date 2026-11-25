import crypto from "node:crypto";
import type { IpcEnvelope } from "../../../../shared/types/ipc/errors.js";
import type { HostConnection, HostHandshakeInfo } from "../../../../shared/types/remoteHosts.js";
import { REMOTE_PROTOCOL_VERSION } from "../../../../shared/types/remoteHosts.js";
import { CHANNELS } from "../../../ipc/channels.js";
import type { HostSetupService } from "../../client/HostSetupService.js";
import { LinkClient } from "../../client/LinkClient.js";
import { SshTransport, type SshSpawner } from "../../client/sshTransport.js";
import { Lane } from "../../link/frames.js";
import { ControlKind, InteractiveKind } from "../../link/messages.js";
import type { LinkSession } from "../../link/session.js";
import { TERMINAL_RESUME_METHOD } from "../../terminal/protocol.js";
import { waitUntil } from "./poll.js";

/** A link from this process to a Host in a container, as a Shell dials it. */

const LINK_TIMEOUT_MS = 60_000;

/** A machine this process reaches over ssh, as the container end to ends start one. */
export interface LinkMachine {
  target: string;
  connection: HostConnection;
  home: string;
  /** A directory for this client's control sockets (see SshTransport). */
  clientDir: string;
  spawnSsh: SshSpawner;
  /** Run a shell line on the machine as the ssh user, around the path under test. */
  shell(script: string, timeoutMs?: number): Promise<string>;
}

export function unwrap<T>(envelope: IpcEnvelope): T {
  if (envelope.ok) return envelope.data as T;
  throw new Error(`[${envelope.error.code ?? "UNKNOWN"}] ${envelope.error.message}`);
}

/**
 * Dial the host as a client on `build` would and wait for the link. With
 * `setup`, a dial that finds no Host serving starts it, as a Shell's does.
 */
export async function connectLink(params: {
  host: LinkMachine;
  build: { version: string; commit: string; arch: "arm64" | "x64" };
  clientName: string;
  /** One install across its connections: it takes back the lease it left. */
  deviceId: string;
  setup?: Pick<HostSetupService, "ensureHostRunning">;
}): Promise<{
  link: LinkClient;
  session: LinkSession;
  handshake: HostHandshakeInfo;
  transport: SshTransport;
}> {
  const { host, build, setup } = params;
  const transport = new SshTransport({
    target: host.target,
    clientDir: host.clientDir,
    spawn: host.spawnSsh,
    ...(setup
      ? {
          ensureRunning: async (signal: AbortSignal) =>
            (await setup.ensureHostRunning(host.connection, signal)) !== "not-startable",
        }
      : {}),
  });
  const link = new LinkClient({
    transport,
    handshake: {
      version: build.version,
      commit: build.commit,
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      platform: "linux",
      arch: build.arch,
    },
    client: {
      clientId: crypto.randomUUID(),
      clientName: params.clientName,
      platform: "linux",
      deviceId: params.deviceId,
    },
  });
  try {
    const session = await new Promise<LinkSession>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`No link: ${JSON.stringify(link.getState())}`)),
        LINK_TIMEOUT_MS
      );
      link.onSession((established) => {
        clearTimeout(timer);
        resolve(established.session);
      });
      link.start();
    });
    const state = link.getState();
    if (state.status !== "connected") throw new Error(`Link is ${state.status}`);
    return { link, session, handshake: state.handshake, transport };
  } catch (err) {
    await link.stop();
    throw err;
  }
}

/**
 * A real terminal on the host: the packaged app's pty-host running a shell in a
 * project, input through the link's stream, and output that only the shell's
 * arithmetic could have produced.
 */
export async function expectWorkingTerminal(
  host: Pick<LinkMachine, "home" | "shell">,
  session: LinkSession
): Promise<void> {
  const endpointId = `e2e-${crypto.randomUUID()}`;
  const openId = crypto.randomUUID();
  session.post({
    lane: Lane.CONTROL,
    kind: ControlKind.ENDPOINT_OPEN,
    body: { endpointId, projectId: null, openId },
  });
  const projectPath = `${host.home}/e2e-project`;
  await host.shell(`mkdir -p "${projectPath}" && git -C "${projectPath}" init --quiet`);
  const project = unwrap<{ id: string; path: string }>(
    await session.invoke(endpointId, CHANNELS.PROJECT_ADD, [projectPath])
  );
  session.post({
    lane: Lane.CONTROL,
    kind: ControlKind.ENDPOINT_REBIND,
    body: { endpointId, projectId: project.id },
  });

  // What a view's relay says on every session: the host holds its stream until then.
  await session.call(TERMINAL_RESUME_METHOD, { endpointId, terminals: [] });

  const terminalId = `e2e-terminal-${crypto.randomUUID()}`;
  let output = "";
  const decoder = new TextDecoder();
  const stopListening = session.on(Lane.INTERACTIVE, InteractiveKind.TERMINAL_OUT, (body) => {
    if (body.endpointId !== endpointId || body.terminalId !== terminalId) return;
    const message = body.message as { type?: string; data?: Uint8Array; bytes?: number };
    if (message.type !== "data" || !message.data) return;
    output += decoder.decode(message.data);
    session.post({
      lane: Lane.INTERACTIVE,
      kind: InteractiveKind.TERMINAL_IN,
      body: { endpointId, message: { type: "ack", id: terminalId, bytes: message.bytes ?? 0 } },
    });
  });
  try {
    unwrap(
      await session.invoke(endpointId, CHANNELS.TERMINAL_SPAWN, [
        { id: terminalId, kind: "terminal", projectId: project.id, cols: 100, rows: 30 },
      ])
    );
    const nonce = crypto.randomBytes(6).toString("hex");
    const write = () =>
      session.post({
        lane: Lane.INTERACTIVE,
        kind: InteractiveKind.TERMINAL_IN,
        body: {
          endpointId,
          message: {
            type: "write",
            id: terminalId,
            // The echoed line reads "$((6*7))"; only the shell turns it into 42.
            data: `echo "${nonce}-$((6*7))-$(uname -s)"\r`,
          },
        },
      });
    write();
    await waitUntil(
      () => output.includes(`${nonce}-42-Linux`),
      `the terminal's answer (saw ${JSON.stringify(output.slice(-400))})`,
      LINK_TIMEOUT_MS
    );
    unwrap(await session.invoke(endpointId, CHANNELS.TERMINAL_KILL, [terminalId]));
  } finally {
    stopListening();
    session.post({
      lane: Lane.CONTROL,
      kind: ControlKind.ENDPOINT_CLOSE,
      body: { endpointId },
    });
  }
}
