export {};

declare global {
  var process:
    | {
        env?: {
          DAINTREE_VERBOSE?: string;
        };
      }
    | undefined;
}

/** Whether Remote Hosts is built in; see electron/types/buildDefines.d.ts. */
declare global {
  const __DAINTREE_REMOTE_HOSTS__: boolean;
}
