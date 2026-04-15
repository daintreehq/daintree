/**
 * Back-compat shim for the Canopy → Daintree rename.
 *
 * Call once at process start. For every `CANOPY_*` env var that is set while
 * the corresponding `DAINTREE_*` is unset, this copies the value onto
 * `process.env.DAINTREE_*` and emits a single deprecation warning. Remove
 * after one release cycle.
 */
export function applyLegacyEnvAliases(processEnv: NodeJS.ProcessEnv = process.env): void {
  const warned = new Set<string>();
  for (const key of Object.keys(processEnv)) {
    if (!key.startsWith("CANOPY_")) continue;
    const newKey = "DAINTREE_" + key.slice("CANOPY_".length);
    if (processEnv[newKey] === undefined && processEnv[key] !== undefined) {
      processEnv[newKey] = processEnv[key];
      if (!warned.has(key)) {
        warned.add(key);
        // eslint-disable-next-line no-console
        console.warn(`[daintree] env var ${key} is deprecated; use ${newKey} instead.`);
      }
    }
  }
}
