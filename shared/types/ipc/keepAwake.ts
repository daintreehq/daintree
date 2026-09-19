/** Whether Daintree keeps the machine from idle-sleeping while agents work (#12516). */
export interface KeepAwakeConfig {
  /** Hold the assertion while any agent is reported as working. Default on. */
  enabled: boolean;
  /** Also hold it while the machine runs on battery. Default off. */
  onBattery: boolean;
}

/** What main is doing about keep-awake right now, pushed on every change. */
export interface KeepAwakeState {
  config: KeepAwakeConfig;
  /** Whether Daintree is holding the power save blocker at this moment. */
  isBlocking: boolean;
  /**
   * Increases each time `config` or `isBlocking` changes, so a renderer can drop
   * a read that a newer push overtook.
   */
  revision: number;
}
