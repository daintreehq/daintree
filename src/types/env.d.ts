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

/** False in Windows builds; see electron/types/buildDefines.d.ts. */
declare global {
  const __DAINTREE_REMOTE_HOSTS__: boolean;
}
