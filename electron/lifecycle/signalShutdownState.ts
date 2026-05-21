let _isSignalShutdown = false;

export const isSignalShutdown = (): boolean => _isSignalShutdown;
export const setSignalShutdown = (): void => {
  _isSignalShutdown = true;
};

// Safety-belt timer handle, set by the signal handler in appLifecycle.ts and
// cleared by the shutdown.ts before-quit handler before every app.exit() call.
// Held here (not in appLifecycle.ts) so shutdown.ts can cancel it without
// importing appLifecycle.ts — those modules cross-import would be a cycle.
let _safetyBeltTimer: ReturnType<typeof setTimeout> | null = null;

export const setSafetyBeltTimer = (handle: ReturnType<typeof setTimeout> | null): void => {
  _safetyBeltTimer = handle;
};

export const clearSafetyBeltTimer = (): void => {
  if (_safetyBeltTimer !== null) {
    clearTimeout(_safetyBeltTimer);
    _safetyBeltTimer = null;
  }
};
