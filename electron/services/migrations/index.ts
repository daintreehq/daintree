import type { Migration } from "../StoreMigrations.js";
import { migration002 } from "./002-add-terminal-location.js";
import { migration003 } from "./003-migrate-recipes-to-project.js";
import { migration004 } from "./004-upgrade-correction-model.js";
import { migration005 } from "./005-add-getting-started-checklist.js";
import { migration006 } from "./006-rename-theme-canopy-to-daintree.js";
import { migration007 } from "./007-reduce-default-terminal-scrollback.js";
import { migration008 } from "./008-split-notification-sounds.js";
import { migration009 } from "./009-per-project-window-state.js";
import { migration010 } from "./010-add-working-pulse-setting.js";
import { migration011 } from "./011-minimal-soundscape-defaults.js";
import { migration012 } from "./012-default-pin-agents.js";
import { migration013 } from "./013-cleanup-phantom-pins.js";
import { migration014 } from "./014-consolidate-telemetry-consent.js";
import { migration015 } from "./015-activation-funnel-and-checklist-rename.js";

export const migrations: Migration[] = [
  migration002,
  migration003,
  migration004,
  migration005,
  migration006,
  migration007,
  migration008,
  migration009,
  migration010,
  migration011,
  migration012,
  migration013,
  migration014,
  migration015,
];
