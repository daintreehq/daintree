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
