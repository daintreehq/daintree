import { getIpcDispatcher } from "../../ipc/dispatcher.js";
import { LOCAL_CLIENT_ID } from "../../ipc/endpoint.js";
import type { ClientEndpoint, ClientRef } from "../../ipc/endpoint.js";
import { getLocalClientRef } from "../../ipc/localEndpoint.js";
import type { SerializedError } from "../../../shared/types/ipc/errors.js";

/**
 * The caller a viewless action runs as: the host itself, acting for one
 * project, with no renderer behind it.
 *
 * It is never added to the endpoint registry, so no broadcast, port or lease
 * can ever address it. Handle 0 is neither a `WebContents` id nor a remote
 * handle, so handlers that key launch-view preferences on a positive sender id
 * find none, and the remote-caller gates that key on a `remote-view` kind leave
 * it alone — this is the host's own call, not a Shell's.
 */
function createViewlessEndpoint(projectId: string): ClientEndpoint {
  return {
    endpointId: `viewless:${projectId}`,
    clientId: LOCAL_CLIENT_ID,
    projectId,
    kind: "local-view",
    handle: 0,
    send: () => {},
    request: (method) =>
      Promise.reject(new Error(`A viewless call has no renderer to answer ${method}`)),
    onClose: () => ({ dispose: () => {} }),
    isClosed: () => false,
  };
}

export class ViewlessInvokeError extends Error {
  readonly code: string | undefined;

  constructor(error: SerializedError) {
    super(error.message);
    this.name = "ViewlessInvokeError";
    this.code = error.code;
  }
}

/**
 * Run one host IPC handler for a project with no renderer attached, through the
 * same dispatcher a remote view's calls go through.
 *
 * This is how the viewless actions stay the renderer's actions: the handler
 * that builds a spawn (cwd validation, project shell overrides, the command
 * launch wrapper, rate limits) or creates a worktree is the one that already
 * serves every window, rather than a second copy of it in main.
 */
export async function invokeHostChannel<T>(
  projectId: string,
  channel: string,
  args: unknown[],
  client: ClientRef = getLocalClientRef()
): Promise<T> {
  const envelope = await getIpcDispatcher().invokeForEndpoint(
    { endpoint: createViewlessEndpoint(projectId), client },
    channel,
    args
  );
  if (!envelope.ok) throw new ViewlessInvokeError(envelope.error);
  return envelope.data as T;
}
