// The runtime names `@daintreehq/plugin-sdk/react` exports, which the host
// serves to zero-build plugin views through its import map. Dependency-free so
// vite.config.ts can hold the built facade to exactly this list; the test
// beside it pins the list to the SDK entry itself.
export const PLUGIN_SDK_REACT_RUNTIME_EXPORTS = [
  "HOST_CHANNEL_CACHE_LIMIT",
  "createViewScope",
  "lazyWithPreload",
  "loadDocumentPackage",
  "resetHostChannelCache",
  "shallowEqual",
  "useActionRunning",
  "useAnimationFrame",
  "useCachedHostChannel",
  "useHostChannel",
  "useHostStore",
  "useNow",
  "usePanelMenuItems",
  "usePanelToolbarItem",
  "usePluginEvent",
  "usePluginEventSelector",
  "usePluginPanelEvent",
  "usePreloadOnIntent",
  "useProgressiveList",
  "useStreamBuffer",
  "useSyncedCollection",
  "useThrottledCallback",
  "useVirtualList",
] as const;
