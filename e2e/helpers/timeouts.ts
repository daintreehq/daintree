const isWindowsCI = process.env.CI && process.platform === "win32";
const CI_MULTIPLIER = isWindowsCI ? 5 : process.env.CI ? 3 : 1;

/** Short timeout for simple visibility checks (3s local / 9s CI / 15s Windows CI) */
export const T_SHORT = 3_000 * CI_MULTIPLIER;

/** Medium timeout for actions that need a moment (5s local / 15s CI / 25s Windows CI) */
export const T_MEDIUM = 5_000 * CI_MULTIPLIER;

/** Long timeout for operations that take a while (10s local / 30s CI / 50s Windows CI) */
export const T_LONG = 10_000 * CI_MULTIPLIER;

/** Settling delay — use after actions that need the UI to catch up */
export const T_SETTLE = isWindowsCI ? 2_000 : process.env.CI ? 1_000 : 500;
