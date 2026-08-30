/**
 * The `component-contract` ESLint plugin — the enforced half of
 * docs/themes/component-contract.md.
 *
 * One plugin rather than five so the config carries a single block and every
 * opt-out comment shares a prefix. All five ship as `warn`: each has thousands
 * of pre-existing violations, and `scripts/lint-ratchet.mjs` grandfathers
 * warnings per rule while failing any increase. Errors are never grandfathered.
 */

import noArbitraryTextSize from "./no-arbitrary-text-size.js";
import noLegacyDaintreeUtilities from "./no-legacy-daintree-utilities.js";
import noRawRadius from "./no-raw-radius.js";
import noTextColorSlashAlpha from "./no-text-color-slash-alpha.js";
import noUnpairedOutlineSuppression from "./no-unpaired-outline-suppression.js";

export default {
  rules: {
    "no-arbitrary-text-size": noArbitraryTextSize,
    "no-legacy-daintree-utilities": noLegacyDaintreeUtilities,
    "no-raw-radius": noRawRadius,
    "no-text-color-slash-alpha": noTextColorSlashAlpha,
    "no-unpaired-outline-suppression": noUnpairedOutlineSuppression,
  },
};
