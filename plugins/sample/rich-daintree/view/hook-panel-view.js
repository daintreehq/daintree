import { useEffect, useState } from "react";
import { jsx } from "react/jsx-runtime";
//#region plugins/sample/rich-daintree/renderer/hook-panel-view.tsx
/**
* Hook-based panel view for the `hook-panel` contribution (#11208).
*
* Authoring source — NOT what ships. `renderer/` is in
* PLUGIN_EXTRA_ASSET_SKIP_DIRS, so the build never copies this file; the
* committed bundle at `../view/hook-panel-view.js` is what `plugin://` loads.
* Regenerate it with `npm run build:sample-rich-view` after changing this.
*
* This is the only view in the repo that exercises the host/plugin React
* contract, and it is deliberately built by the PUBLIC `@daintreehq/plugin-vite`
* preset — the same entry a third-party author uses — so the import map's
* production ABI is proven by the same path real plugins take. Its sibling
* `rich-panel-view.js` imports nothing and stays that way: it isolates
* "`plugin://` is broken" from "the React contract is broken", which are
* different bugs with different fixes.
*
* The mounting → ready transition is the assertion target, and it proves three
* things at once: the named imports below resolved (a bad map fails at module
* load), JSX resolved `react/jsx-runtime`, and the hooks dispatched through the
* HOST's React — a second React copy would throw "Invalid hook call" here
* rather than ever reaching "ready".
*/
function HookPanelView() {
	const [phase, setPhase] = useState("mounting");
	useEffect(() => {
		setPhase("ready");
	}, []);
	return /* @__PURE__ */ jsx("div", {
		"data-testid": "hook-panel-view",
		children: `Hook panel view ${phase}`
	});
}
//#endregion
export { HookPanelView as default };
