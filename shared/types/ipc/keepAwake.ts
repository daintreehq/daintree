/**
 * Whether Daintree keeps the machine from idle-sleeping while agents work
 * (#12516), and the machine and its display while a scheduled run is live
 * (#15981).
 */
export interface KeepAwakeConfig {
  /** Hold the assertion while an agent is reported working or a scheduled run is live. Default on. */
  enabled: boolean;
  /** Also hold it while the machine runs on battery. Default off. */
  onBattery: boolean;
}

/** What main is doing about keep-awake right now, pushed on every change. */
export interface KeepAwakeState {
  config: KeepAwakeConfig;
  /** Whether Daintree is holding a power save blocker at this moment. */
  isBlocking: boolean;
  /** Whether that includes the display: held for scheduled runs alone. */
  isDisplayBlocking: boolean;
  /**
   * The scheduled runs asking for the hold, oldest first: registered in this
   * lifetime and not yet ended or deleted. They hold the display only while
   * the setting and the power source allow it, so a run can be listed while
   * nothing is held.
   */
  scheduledRunIds: string[];
  /**
   * Increases each time any other field changes, so a renderer can drop
   * a read that a newer push overtook.
   */
  revision: number;
}
