import type { MessagePortMain } from "electron";

/**
 * The slice of a message port the stream bridges use. Main-process ports
 * (`MessagePortMain`) wrap the payload in an event; tests use Node's
 * `worker_threads` ports, which deliver the value itself. Both are adapted to
 * this shape so the bridges never guess which one they hold — a heuristic like
 * "has a `data` field" would misfire on terminal `data` messages.
 */
export interface PortLike {
  postMessage(message: unknown): void;
  onMessage(listener: (message: unknown) => void): void;
  onClose(listener: () => void): void;
  close(): void;
}

export function wrapMainPort(port: MessagePortMain): PortLike {
  return {
    postMessage: (message) => port.postMessage(message),
    onMessage: (listener) => {
      port.on("message", (event) => listener(event.data));
      port.start();
    },
    onClose: (listener) => {
      port.on("close", listener);
    },
    close: () => {
      try {
        port.close();
      } catch {
        // Already closed or transferred.
      }
    },
  };
}

/** Post without letting a closing port take the caller down. */
export function safePost(port: PortLike | null, message: unknown): boolean {
  if (!port) return false;
  try {
    port.postMessage(message);
    return true;
  } catch {
    return false;
  }
}
