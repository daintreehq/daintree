/** Configuration for restoring live projects across a relaunch (#12320). */
export interface SessionRestoreConfig {
  /**
   * Whether a relaunch brings back every project that was live, or only the
   * one project each window was showing. Default on.
   */
  enabled: boolean;
}
