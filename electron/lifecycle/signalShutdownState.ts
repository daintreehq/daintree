let _isSignalShutdown = false;

export const isSignalShutdown = (): boolean => _isSignalShutdown;
export const setSignalShutdown = (): void => {
  _isSignalShutdown = true;
};
