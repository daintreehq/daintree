/**
 * The `component-contract` ESLint plugin — the enforced half of
 * docs/themes/component-contract.md.
 *
 * One plugin rather than six so the config carries a single block and every
 * opt-out comment shares a prefix. Five ship as `warn`: each has thousands of
 * pre-existing violations, and `scripts/lint-ratchet.mjs` grandfathers warnings
 * per rule while failing any increase. `no-raw-shadow` shipped with none left,
 * so it is an error. Errors are never grandfathered.
 */

import noArbitraryTextSize from "./no-arbitrary-text-size.js";
import noLegacyDaintreeUtilities from "./no-legacy-daintree-utilities.js";
import noRawRadius from "./no-raw-radius.js";
import noRawShadow from "./no-raw-shadow.js";
import noTextColorSlashAlpha from "./no-text-color-slash-alpha.js";
import noUnpairedOutlineSuppression from "./no-unpaired-outline-suppression.js";

export default {
  rules: {
    "no-arbitrary-text-size": noArbitraryTextSize,
    "no-legacy-daintree-utilities": noLegacyDaintreeUtilities,
    "no-raw-radius": noRawRadius,
    "no-raw-shadow": noRawShadow,
    "no-text-color-slash-alpha": noTextColorSlashAlpha,
    "no-unpaired-outline-suppression": noUnpairedOutlineSuppression,
  },
};
