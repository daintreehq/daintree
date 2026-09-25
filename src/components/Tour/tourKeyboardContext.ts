import { createContext, useContext } from "react";
import { currentTourKeyboard, type TourKeyboard } from "./tourKeys";

/** Which keyboard the narration speaks, so scenes draw the keys it names. */
export const TourKeyboardContext = createContext<TourKeyboard>(currentTourKeyboard());

export function useTourKeyboard(): TourKeyboard {
  return useContext(TourKeyboardContext);
}
