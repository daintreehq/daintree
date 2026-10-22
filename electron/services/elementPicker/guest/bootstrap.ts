/// <reference lib="dom" />
/**
 * The core picker's bootstrap exactly as the host installs it: built by
 * `scripts/build-main.mjs` into `dist-electron/element-picker/guest/bootstrap.js`
 * and evaluated into the picker's own isolated world in every bound document.
 *
 * The host prelude (`electron/services/elementPicker/guestSources.ts`) splices
 * this asset into a scope where it has already declared `api`, so `api` is a
 * free identifier here and must stay one: the prelude owns the envelope, the
 * session, the epoch and the sequence.
 */

import { createPicker } from "./picker.js";
import type { BootstrapHostApi, PickerMode } from "./types.js";

declare const api: BootstrapHostApi;

const picker = createPicker({
  channel: api.channel,
  mode: api.mode,
  post: (event) => api.post(event),
});

api.setMode = (mode: PickerMode) => {
  api.mode = mode;
  picker.setMode(mode);
};
api.clearSelection = () => picker.clearSelection();
api.clearHover = () => picker.clearHover();
api.refresh = () => picker.refresh();
api.dispose = () => picker.dispose();
