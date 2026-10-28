import { n as EVENTS, t as CHANNELS } from "./contracts-Bojho-XK.js";
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
function getPluginHostBridge() {
	const bridge = globalThis.electron?.plugin;
	if (!bridge) throw new Error("@daintreehq/plugin-sdk/react: window.electron.plugin is unavailable — these hooks run only inside a Daintree plugin renderer view.");
	return bridge;
}
var EMPTY = /* @__PURE__ */ Object.freeze({
	data: void 0,
	error: null,
	validating: false,
	updatedAt: 0
});
var states = /* @__PURE__ */ new Map();
var listeners = /* @__PURE__ */ new Map();
var inFlight = /* @__PURE__ */ new Map();
var staleMarks = /* @__PURE__ */ new Map();
var nextSeq = 0;
var invalidations = /* @__PURE__ */ new Map();
function invalidationFor(key) {
	let entry = invalidations.get(key);
	if (!entry) {
		entry = {
			timer: null,
			queued: false,
			subscribers: /* @__PURE__ */ new Set()
		};
		invalidations.set(key, entry);
	}
	return entry;
}
function runInvalidation(key, entry) {
	const [subscriber] = entry.subscribers;
	if (!subscriber || invalidations.get(key) !== entry) return;
	subscriber.refetch();
}
function invalidate(key, debounceMs) {
	staleMarks.set(key, ++nextSeq);
	const entry = invalidations.get(key);
	if (!entry) return;
	if (entry.timer !== null) clearTimeout(entry.timer);
	entry.timer = setTimeout(() => {
		entry.timer = null;
		const busy = inFlight.get(key);
		if (!busy) {
			runInvalidation(key, entry);
			return;
		}
		if (entry.queued) return;
		entry.queued = true;
		busy.promise.finally(() => {
			entry.queued = false;
			if (entry.timer !== null) clearTimeout(entry.timer);
			entry.timer = null;
			runInvalidation(key, entry);
		});
	}, debounceMs);
}
function leaveInvalidation(key, subscriber) {
	const entry = invalidations.get(key);
	if (!entry) return;
	entry.subscribers.delete(subscriber);
	if (entry.subscribers.size > 0) return;
	if (entry.timer !== null) clearTimeout(entry.timer);
	invalidations.delete(key);
}
function touch(key) {
	const state = states.get(key);
	if (state) {
		states.delete(key);
		states.set(key, state);
	}
	return state;
}
function evict() {
	for (const key of states.keys()) {
		if (states.size <= 50) return;
		if (!listeners.has(key) && !inFlight.has(key)) {
			states.delete(key);
			staleMarks.delete(key);
		}
	}
}
function write(key, next) {
	states.delete(key);
	states.set(key, next);
	evict();
	const subs = listeners.get(key);
	if (subs) for (const notify of [...subs]) notify();
}
function subscribeKey(key, notify) {
	let subs = listeners.get(key);
	if (!subs) listeners.set(key, subs = /* @__PURE__ */ new Set());
	subs.add(notify);
	return () => {
		subs.delete(notify);
		if (subs.size === 0 && listeners.get(key) === subs) listeners.delete(key);
		evict();
	};
}
function toError(err) {
	return err instanceof Error ? err : new Error(String(err));
}
function request(key, pluginId, channel, args, supersede) {
	const current = inFlight.get(key);
	const mark = staleMarks.get(key);
	if (current && !supersede && (mark === void 0 || mark < current.seq)) return current.promise;
	const seq = ++nextSeq;
	const prev = states.get(key) ?? EMPTY;
	if (!prev.validating) write(key, {
		...prev,
		validating: true
	});
	const promise = Promise.resolve().then(() => getPluginHostBridge().invoke(pluginId, channel, args)).then((data) => {
		if (inFlight.get(key)?.seq !== seq) return void 0;
		inFlight.delete(key);
		const marked = staleMarks.get(key);
		if (marked !== void 0 && marked < seq) staleMarks.delete(key);
		write(key, {
			data,
			error: null,
			validating: false,
			updatedAt: Date.now()
		});
		return data;
	}, (err) => {
		if (inFlight.get(key)?.seq !== seq) return void 0;
		inFlight.delete(key);
		write(key, {
			...states.get(key) ?? EMPTY,
			error: toError(err),
			validating: false
		});
	});
	inFlight.set(key, {
		seq,
		promise
	});
	return promise;
}
function encodeArgs(value, seen) {
	switch (typeof value) {
		case "undefined": return "u";
		case "boolean": return value ? "t" : "f";
		case "number": return Object.is(value, -0) ? "n-0" : `n${String(value)}`;
		case "string": return JSON.stringify(value);
		case "object": {
			if (value === null) return "z";
			if (seen.has(value)) throw new TypeError("cyclic args");
			seen.add(value);
			let out;
			if (Array.isArray(value)) out = `[${value.map((v) => encodeArgs(v, seen)).join(",")}]`;
			else {
				const proto = Object.getPrototypeOf(value);
				if (proto !== Object.prototype && proto !== null) throw new TypeError("non-plain args");
				const record = value;
				out = `{${Object.keys(record).sort().map((k) => `${JSON.stringify(k)}:${encodeArgs(record[k], seen)}`).join(",")}}`;
			}
			seen.delete(value);
			return out;
		}
		default: throw new TypeError("unserialisable args");
	}
}
function cacheKeyFor(pluginId, channel, args, cacheKey) {
	let argsKey = cacheKey;
	if (argsKey === void 0) try {
		argsKey = encodeArgs(args, /* @__PURE__ */ new Set());
	} catch {
		throw new Error(`@daintreehq/plugin-sdk/react: useCachedHostChannel could not serialise the args for "${channel}"; pass options.cacheKey.`);
	}
	return JSON.stringify([
		pluginId,
		channel,
		argsKey
	]);
}
function invalidationChannelsKey(invalidateOn) {
	const channels = [...new Set((typeof invalidateOn === "string" ? [invalidateOn] : Array.isArray(invalidateOn) ? invalidateOn : []).filter((c) => typeof c === "string" && c.length > 0))].sort();
	return channels.length > 0 ? JSON.stringify(channels) : "";
}
function useCachedHostChannel(pluginId, channel, args, options = {}) {
	const { staleMs = 0, cacheKey, signal, enabled = true, invalidateOn, debounceMs = 100 } = options;
	const key = cacheKeyFor(pluginId, channel, args, cacheKey);
	const invalidateKey = invalidationChannelsKey(invalidateOn);
	const subscribe = useCallback((notify) => subscribeKey(key, notify), [key]);
	const getSnapshot = useCallback(() => states.get(key) ?? EMPTY, [key]);
	const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
	const argsRef = useRef(args);
	useEffect(() => {
		argsRef.current = args;
	});
	useEffect(() => {
		if (!enabled || signal?.aborted) return;
		const cached = touch(key);
		if (cached !== void 0 && cached.updatedAt > 0 && Date.now() - cached.updatedAt < staleMs && !staleMarks.has(key)) return;
		request(key, pluginId, channel, argsRef.current, false);
	}, [
		key,
		enabled,
		staleMs,
		signal,
		pluginId,
		channel
	]);
	useEffect(() => {
		if (!invalidateKey || !enabled || signal?.aborted) return;
		const wait = Math.max(0, debounceMs);
		const args2 = argsRef;
		const subscriber = { refetch: () => request(key, pluginId, channel, args2.current, true) };
		invalidationFor(key).subscribers.add(subscriber);
		const bridge = getPluginHostBridge();
		const offs = JSON.parse(invalidateKey).map((pushChannel) => bridge.on(pluginId, pushChannel, () => {
			if (signal?.aborted) return;
			invalidate(key, wait);
		}));
		const leave = () => leaveInvalidation(key, subscriber);
		signal?.addEventListener("abort", leave, { once: true });
		return () => {
			for (const off of offs) off();
			signal?.removeEventListener("abort", leave);
			leave();
		};
	}, [
		invalidateKey,
		enabled,
		signal,
		debounceMs,
		key,
		pluginId,
		channel
	]);
	const revalidate = useCallback(async () => {
		if (signal?.aborted) return void 0;
		return await request(key, pluginId, channel, argsRef.current, true);
	}, [
		key,
		signal,
		pluginId,
		channel
	]);
	return {
		data: state.data,
		error: state.error,
		validating: state.validating,
		updatedAt: state.updatedAt,
		revalidate
	};
}
/**
* Reads the views share. Each is cached across mounts and refetched only when
* the worker pushes the matching event, so switching between Home, the
* sidebar and the grid never re-asks for what is already on screen, and no
* view polls.
*/
function useRequests(pluginId) {
	return useCachedHostChannel(pluginId, CHANNELS.list, {}, { invalidateOn: EVENTS.requestsChanged });
}
function useReports(pluginId) {
	return useCachedHostChannel(pluginId, CHANNELS.reports, {}, { invalidateOn: EVENTS.reportsChanged });
}
function useConnection(pluginId) {
	return useCachedHostChannel(pluginId, CHANNELS.connection, {}, { invalidateOn: EVENTS.connectionChanged });
}
function call(pluginId, channel, args) {
	return window.electron.plugin.invoke(pluginId, channel, args);
}
export { useCachedHostChannel as a, useRequests as i, useConnection as n, useReports as r, call as t };
