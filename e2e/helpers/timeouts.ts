/** CI-aware timeout multiplier. CI runners are significantly slower. */
const CI_MULTIPLIER = process.env.CI ? 3 : 1;

/** Short timeout for simple visibility checks (3s local, 9s CI) */
export const T_SHORT = 3_000 * CI_MULTIPLIER;

/** Medium timeout for actions that need a moment (5s local, 15s CI) */
export const T_MEDIUM = 5_000 * CI_MULTIPLIER;

/** Long timeout for operations that take a while (10s local, 30s CI) */
export const T_LONG = 10_000 * CI_MULTIPLIER;
