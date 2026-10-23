// Hibernation no longer occurs: `isHibernated` is always false and
// `subscribeHibernation` never notifies, so the hook needs no service at all.
export function useIsHibernated(_id: string): boolean {
  return false;
}
