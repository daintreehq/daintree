import type { Migration } from "../StoreMigrations.js";
import { migration002 } from "./002-add-terminal-location.js";
import { migration003 } from "./003-migrate-recipes-to-project.js";
import { migration004 } from "./004-upgrade-correction-model.js";
import { migration005 } from "./005-add-getting-started-checklist.js";
import { migration006 } from "./006-rename-theme-canopy-to-daintree.js";
import { migration007 } from "./007-reduce-default-terminal-scrollback.js";

export const migrations: Migration[] = [
  migration002,
  migration003,
  migration004,
  migration005,
  migration006,
  migration007,
];
