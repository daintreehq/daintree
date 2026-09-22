import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
import type { CloneRepoProgressEvent } from "@shared/types/ipc/gitClone";

/**
 * Standalone visual-review harness for `CloneRepoDialog`.
 *
 * The real dialog, the real theme tokens and the real `index.css`, served by
 * Vite. The five bridge calls the dialog makes are answered here, and
 * everything above them is the product's: the spec types into the fields,
 * presses Browse and Clone, and pushes git progress through the same
 * `onCloneProgress` subscription the main process feeds.
 *
 * Query parameters:
 *   ?theme=daintree|bondi|…    built-in theme id
 *   ?outcome=hang|success|error|auth|cancel   what `cloneRepo` does once called
 *   ?providers=1|0             one GitHub provider (shorthand + sign-in) or none
 *
 * The spec drives progress with `window.__cloneShot.emit(event)` and ends a
 * held clone with `window.__cloneShot.settle()`.
 */

const params = new URLSearchParams(window.location.search);
const outcome = params.get("outcome") ?? "hang";
const withProvider = params.get("providers") !== "0";

type Listener = (event: CloneRepoProgressEvent) => void;
const listeners = new Set<Listener>();
/** A settled outcome still resolves on a later tick, as a real IPC round trip does. */
const SETTLED_CLONE_MS = 50;
let release: (() => void) | null = null;
let cancelled = false;

function encodedGitError(reason: string, message: string): Error {
  return new Error(`[GitError|${reason}||] ${message}`);
}

const shot = {
  emit(event: CloneRepoProgressEvent) {
    for (const listener of listeners) listener(event);
  },
  settle() {
    release?.();
  },
};
Reflect.set(window, "__cloneShot", shot);

installPreviewShims({
  project: new Proxy(
    {
      openDialog: async () => "/Users/you/Code",
      onCloneProgress: (callback: Listener) => {
        listeners.add(callback);
        return () => listeners.delete(callback);
      },
      cancelClone: async () => {
        cancelled = true;
        release?.();
      },
      cloneRepo: async (options: { parentPath: string; folderName: string }) => {
        cancelled = false;
        if (outcome === "hang") {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        } else {
          await new Promise((resolve) => setTimeout(resolve, SETTLED_CLONE_MS));
        }
        if (cancelled) throw new Error("[AppError|CANCELLED] Clone cancelled");
        if (outcome === "auth") {
          throw encodedGitError(
            "auth-failed",
            "Authentication failed for 'https://github.com/helios-labs/helios-dashboard.git/'"
          );
        }
        if (outcome === "error") {
          throw encodedGitError(
            "unknown",
            "repository 'https://github.com/helios-labs/helios-dashboard.git/' not found"
          );
        }
        return { clonedPath: `${options.parentPath}/${options.folderName}` };
      },
    },
    {
      get: (target, key) =>
        key in target ? Reflect.get(target, key) : () => Promise.resolve(undefined),
    }
  ),
  forge: {
    getProviders: async () =>
      withProvider
        ? [
            {
              pluginId: "daintree.github",
              contribution: { id: "github", name: "GitHub", matches: ["github.com"] },
            },
          ]
        : [],
  },
});
