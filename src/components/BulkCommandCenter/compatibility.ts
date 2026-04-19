import { useFleetDeckStore } from "@/store/fleetDeckStore";

/**
 * @deprecated Use `useFleetDeckStore.getState().openWithScope("all")` instead.
 * The Bulk Command Palette has been retired in favor of the Fleet Deck.
 */
export function openBulkCommandPalette(): void {
  console.warn(
    "[deprecation] openBulkCommandPalette() is deprecated. Use Fleet Deck instead (fleet.deck.open or Cmd+Shift+B)."
  );
  useFleetDeckStore.getState().openWithScope("all");
}
