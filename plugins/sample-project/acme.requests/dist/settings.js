import { t as CHANNELS } from "./contracts-Bojho-XK.js";
import { n as useConnection, t as call } from "./data-DYsOgj87.js";
import { Button, Input, SettingsRow, Text } from "@daintreehq/plugin-ui";
import { useEffect, useRef, useState } from "react";
import { jsx, jsxs } from "react/jsx-runtime";
var WORKSPACE_SETTING = "providerWorkspace";
/**
* Request Desk's settings section: rows only, under the host's own heading
* and group, applied as they change with no Save. The root holds the one
* control the setup step deep-links to; the Connection page holds the rest.
* The view never holds a credential — this provider has none, and a real one
* would keep its token in a `type: "secret"` setting the worker reads.
*/
function Settings({ pluginId, settingsContext }) {
	const connection = useConnection(pluginId);
	const page = settingsContext?.page ?? null;
	const focus = settingsContext?.focus;
	const inputRef = useRef(null);
	const [workspace, setWorkspace] = useState("");
	const [busy, setBusy] = useState(false);
	const [test, setTest] = useState(null);
	useEffect(() => {
		if (!focus || focus.key !== WORKSPACE_SETTING) return;
		if (page !== null || !inputRef.current) {
			focus.acknowledge(false);
			return;
		}
		inputRef.current.focus();
		focus.acknowledge(true);
	}, [focus, page]);
	const run = async (channel, args) => {
		setBusy(true);
		try {
			await call(pluginId, channel, args);
			setTest(null);
			await connection.revalidate();
		} finally {
			setBusy(false);
		}
	};
	const status = connection.data;
	if (page === "connection") return /* @__PURE__ */ jsxs("div", {
		className: "divide-y divide-border-subtle",
		children: [
			/* @__PURE__ */ jsx(SettingsRow, {
				label: "Status",
				description: status?.connected ? `Connected to ${status.workspace}` : "Not connected",
				control: /* @__PURE__ */ jsx(Button, {
					variant: "outline",
					size: "sm",
					loading: busy,
					onClick: async () => setTest(await call(pluginId, CHANNELS.testConnection)),
					children: "Test connection"
				})
			}),
			test ? /* @__PURE__ */ jsx(SettingsRow, {
				label: "Last test",
				control: /* @__PURE__ */ jsx(Text, {
					tone: test.ok ? "success" : "danger",
					children: test.message
				})
			}) : null,
			/* @__PURE__ */ jsx(SettingsRow, {
				label: "Disconnect",
				description: "Reports already built stay. New ones need a workspace.",
				disabled: !status?.connected,
				control: /* @__PURE__ */ jsx(Button, {
					variant: "ghost-danger",
					size: "sm",
					disabled: !status?.connected || busy,
					onClick: () => void run(CHANNELS.disconnect),
					children: "Disconnect"
				})
			})
		]
	});
	return /* @__PURE__ */ jsx("div", {
		className: "divide-y divide-border-subtle",
		children: /* @__PURE__ */ jsx(SettingsRow, {
			label: "Report provider workspace",
			description: status?.connected ? `Connected to ${status.workspace}. Synthetic and offline: nothing leaves this machine.` : "Name any workspace. The synthetic provider accepts it offline.",
			control: ({ labelId }) => status?.connected ? /* @__PURE__ */ jsx(Text, { children: status.workspace }) : /* @__PURE__ */ jsxs("span", {
				className: "flex gap-1.5",
				children: [/* @__PURE__ */ jsx(Input, {
					ref: inputRef,
					value: workspace,
					onValueChange: setWorkspace,
					placeholder: "Demo workspace",
					"aria-labelledby": labelId
				}), /* @__PURE__ */ jsx(Button, {
					size: "sm",
					loading: busy,
					onClick: () => void run(CHANNELS.connect, { workspace }),
					children: "Connect"
				})]
			})
		})
	});
}
export { Settings as default };
