/**
 * Built plugin entry — the file Daintree actually loads. Committed on purpose:
 * a project-local plugin's dist/ IS the load contract, and the host never
 * compiles src/. Kept hand-written and trivial so the fixture has no build.
 */
export async function activate() {
  return () => {};
}
