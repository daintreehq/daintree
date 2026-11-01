// The first request to see a Daintree an OS job started with no window
// (#15989). Kept free of Electron so its ordering is testable on its own; the
// real steps are wired in main.ts.

export interface InitialWindowRequestDeps {
  /** Opens the windows a launch would have opened: the restored fleet, a folder's window, or recovery. */
  openLaunchWindows(): Promise<void>;
  /** One plain window, for every request after the first. */
  createWindow(): Promise<void>;
  isShuttingDown(): boolean;
}

export interface InitialWindowRequest {
  /** Opens the launch's windows the first time, and a plain window after that. */
  open(): Promise<void>;
}

/**
 * The launch's own windows open once, on the first request: requests that
 * arrive while they open join it, so repeated Dock clicks and relaunches never
 * restore the fleet twice. Settled either way, since a fleet that partly came
 * back would be restored again on top of itself.
 */
export function createInitialWindowRequest(deps: InitialWindowRequestDeps): InitialWindowRequest {
  let opening: Promise<void> | null = null;
  let opened = false;

  return {
    open() {
      if (deps.isShuttingDown()) return Promise.resolve();
      if (opened) return deps.createWindow();
      opening ??= Promise.resolve()
        .then(() => deps.openLaunchWindows())
        .finally(() => {
          opened = true;
          opening = null;
        });
      return opening;
    },
  };
}
