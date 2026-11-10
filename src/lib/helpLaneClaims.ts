// Slots an in-flight help launch has chosen but not yet bound. Provisioning a
// slot displaces whatever holds it, so a second launch picking the same slot
// before the first binds would kill the first, and a tab closed under it would
// strand it. Module state is per V8 context, i.e. per project view — the same
// scope as the store these slots index.
export const claimedHelpLaneKeys = new Set<string>();
