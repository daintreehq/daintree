# Voice dictation & transcription pipeline

Daintree can dictate directly into a terminal (or the Daintree Assistant) input: real-time streaming transcription, client-side voice-activity detection (VAD), push-to-talk, a pause state, target-follows-focus routing, and an optional whole-passage AI cleanup pass. The feature spans both processes — microphone capture and editor injection live in the renderer, while WebSocket transport, segmentation, and the OpenAI/Deepgram backends live in the main process. This doc captures how the pieces fit so the flow doesn't have to be reverse-engineered from ~2,500 LOC across the two sides.

For how these IPC channels are registered and dispatched, see [ipc-services.md](./ipc-services.md).

## Mental model

There are two long-lived singletons, one per process, talking over a small set of `voice-input:*` IPC channels:

- **Renderer:** `voiceRecordingService` (`src/services/VoiceRecordingService.ts`, ~1500 LOC) owns the microphone, the `AudioContext`/worklet capture graph, session lifecycle (arming → connecting → recording → finishing), all keyboard wiring (PTT, Escape, blur), and **all editor injection**. It pushes raw PCM16 chunks to the main process and applies the delta/complete/file-token/paragraph events it gets back to the focused terminal's draft.
- **Main:** `VoiceTranscriptionService` (`electron/services/VoiceTranscriptionService.ts`) is a thin selector + event-forwarder over a pluggable `TranscriptionProvider`. The provider owns its own WebSocket, auth, audio encoding, segmentation, reconnection, and drain. Two providers exist today: `OpenAITranscriptionProvider` and `DeepgramTranscriptionProvider`.

The renderer never knows which backend is in use; the main process never touches the editor. The IPC handler (`electron/ipc/handlers/voiceInput.ts`) is the seam — it forwards provider events to the renderer, runs post-processing (dictation commands, paragraph splitting, file-link detection), and exposes correction + mic-permission RPCs.

```text
 RENDERER (src/)                          MAIN (electron/)
 ┌────────────────────────────┐          ┌──────────────────────────────────────────┐
 │ voiceRecordingService      │          │ voiceInput.ts (IPC handler)                │
 │  AudioContext 24kHz        │  audio   │   getService() → VoiceTranscriptionService │
 │  pcm-processor worklet ────┼─chunk───►│     ├─ OpenAITranscriptionProvider          │
 │  RMS level → glow          │  (raw    │     │    └─ openaiVadWorker (Silero v5)      │
 │                            │  PCM16)  │     └─ Deepgram… (server-side VAD)          │
 │  onDelta / onComplete  ◄───┼─events───┤   provider.onEvent → applyDictationCommands │
 │  onParagraphBoundary   ◄───┤          │     → split → send delta/complete/boundary  │
 │  onFileTokenResolved   ◄───┤          │   detectFileLinkTokens → VoiceFileLinkResolver
 │  onError / onStatus    ◄───┤          │   correct() → VoiceCorrectionService        │
 │                            │          │                                            │
 │  injects into terminal     │  correct │                                            │
 │  draft (terminalInputStore)├─RPC─────►│                                            │
 └────────────────────────────┘          └──────────────────────────────────────────┘
 voiceRecordingStore (status, buffers, recents)   store("voiceInput") = VoiceInputSettings
```

## End-to-end flow

1. **Invoke.** A keybinding, palette, menu, or toolbar press hits `voiceInput.toggle` / `voiceInput.toggleAssistant` / `voiceInput.togglePause` (`src/services/actions/definitions/voiceActions.ts`). Toolbar callers use `voiceRecordingService.toggle()` directly; hotkey callers route through `toggleFocusedPanel()` / `toggleAssistant()`, which resolve the target (see "Target routing") and call `startOrToggle()`.
2. **Arming.** `toggle()` synchronously sets `status: "arming"` in the store (`setArming`) so the target panel border and toolbar paint a pre-recording cue within ~50ms, before any `await`. A second press during arming aborts (`cancelArming()` bumps `startRequestId` so the in-flight `start()` bails at its next staleness check).
3. **Permission + capture.** `start()` checks/raises OS mic permission via IPC (`checkMicPermission` / `requestMicPermission` / `openMicSettings` — macOS `systemPreferences`, Windows `ms-settings`, Linux best-effort), then `getUserMedia`, then builds a 24kHz `AudioContext`, loads the `pcm-processor` worklet (`/pcm-processor.js`), and connects a silent keep-alive oscillator so Chromium doesn't suspend the capture-only context when backgrounded. Capture starts **eagerly** — PCM chunks flow before the WebSocket is open; the provider buffers them.
4. **Stream.** Each worklet message carries an `ArrayBuffer` of PCM16. The renderer computes RMS for the UI glow (`setAudioLevel`, throttled to one RAF) and ships the chunk via `voiceInput.sendAudioChunk` (`ipcRenderer.send`, fire-and-forget). Main forwards it to the active provider.
5. **Segment + transcribe.** The provider commits utterance segments (VAD-driven for OpenAI, server-side for Deepgram) and emits `delta` / `complete` events back through the handler.
6. **Inject.** The handler post-processes each `complete` (dictation commands, paragraph splitting, file-link detection) and sends `delta` / `complete` / `paragraph_boundary` / `file_token_resolved` to the renderer. `voiceRecordingService` writes them into the focused terminal's draft through `terminalInputStore`.
7. **Stop + correct.** `stop()` drains the provider gracefully, flushes any trailing interim text, and — if AI correction is enabled and the stop was deliberate — fires one whole-passage correction pass (`runCorrection`) over the dictated range.

### Text-injection model (important)

Interim `delta` text is **never** written into the editor document. It accumulates only in `liveText` in `voiceRecordingStore` and is rendered as a CodeMirror ghost-widget decoration (`useVoiceDecorations`, `src/components/Terminal/hooks/useVoiceDecorations.ts`), outside the doc model. Only a `complete` event writes real text, so the editor's undo history records **one transaction per utterance** rather than one per token (#9172). The service tracks several draft offsets per panel buffer to splice correctly:

- `sessionDraftStart` — where the whole session's dictated text begins (anchor for `runCorrection`).
- `draftLengthAtSegmentStart` — where the current segment begins; a `complete` slices back to here and replaces, so re-firing is idempotent.
- `activeParagraphStart` — paragraph anchor for boundary handling.

A leading separator space is inserted via `getVoiceInsertMetadata` when the existing draft doesn't end in whitespace.

## TranscriptionProvider abstraction

`electron/services/voice/TranscriptionProvider.ts` defines the contract. A provider owns its own WebSocket connection, authentication, audio encoding, server-event parsing, reconnection, and any timers its protocol needs. `VoiceTranscriptionService` only selects one (from `settings.transcriptionProvider`), subscribes, and forwards — it holds no transcription logic itself and tears the previous provider down on every `start()` so a provider switch or plain restart can't leak a socket or listener.

```ts
interface TranscriptionProvider {
  readonly hasServerVAD: boolean; // false → provider drives client-side segmentation
  start(settings): Promise<VoiceStartResult>;
  sendAudioChunk(chunk: ArrayBuffer): void;
  commitParagraphBoundary(): void; // flush at a user-driven Enter boundary; no-op for server-VAD
  stopGracefully(): Promise<void>; // drain pending transcripts, then close
  stop(): void; // hard stop
  destroy(): void;
  onEvent(listener): () => void;
}
```

`VoiceTranscriptionEvent` is the neutral event union: `delta` / `complete` / `paragraph_boundary` / `error` / `status`. Word-level confidence is **not** produced by the transcription stream — both providers emit `STUB_CONFIDENCE` (fully-confident stub). The real correction pass lives in `VoiceCorrectionService`, so the renderer's confidence shape stays backend-independent.

| Provider | `hasServerVAD` | Endpoint | Audio on wire | Segmentation | Keep-alive |
| --- | --- | --- | --- | --- | --- |
| `OpenAITranscriptionProvider` | `false` | `wss://api.openai.com/v1/realtime?intent=transcription`, model `gpt-live-transcribe` | base64 JSON `input_audio_buffer.append` | client-side Silero VAD worker + 8s backstop | ping/pong heartbeat (20s) |
| `DeepgramTranscriptionProvider` | `true` | `wss://api.deepgram.com/v1/listen`, model `nova-3` | raw binary frames, `linear16` @ 24kHz | server-side `endpointing=300` | `KeepAlive` frame (5s) |

Both buffer up to `PRE_CONNECT_BUFFER_MAX` (100) chunks / `150_000` bytes (~3s) while connecting or reconnecting, then flush on session-ready. WebSocket URLs accept env overrides (`DAINTREE_REALTIME_WS_URL`, `DAINTREE_DEEPGRAM_WS_URL`) for testing.

### Adding a provider

1. Implement `TranscriptionProvider` in `electron/services/voice/`. Set `hasServerVAD`; if `false`, drive your own commit cadence and implement `commitParagraphBoundary()` to flush mid-utterance.
2. Add the literal to `VoiceTranscriptionProvider` in `shared/types/ipc/api.ts` and to `VALID_TRANSCRIPTION_PROVIDERS` in `electron/ipc/handlers/voiceInput.ts`.
3. Add the `case` to `VoiceTranscriptionService.createProvider`.
4. Decide the API-key field: `refreshConfiguration()` in the renderer treats Deepgram as needing `deepgramApiKey` and everything else as needing `openaiApiKey` — extend that branch if your provider uses a distinct key.
5. Emit `STUB_CONFIDENCE` on `complete` unless you genuinely have word-level confidence.

## OpenAI session config

`OpenAITranscriptionProvider` sends one `session.update` on open (and re-sends the identical payload on every reconnect, rebuilt from the frozen settings snapshot):

```jsonc
{
  "type": "session.update",
  "session": {
    "type": "transcription",
    "audio": {
      "input": {
        "format": { "type": "audio/pcm", "rate": 24000 },
        "transcription": {
          "model": "gpt-live-transcribe",
          "languages": ["en"], // array supersedes the deprecated singular `language` — never send both
          "delay": "low",
          "keywords": ["Daintree"], // omitted entirely when nothing survives sanitising
          "prompt": "Keywords: Daintree",
        },
        "turn_detection": null,
      },
    },
  },
}
```

`languages` is a one-element array built from the single language code in settings, falling back to `["en"]` when unset. `delay` (`minimal` | `low` | `medium` | `high` | `xhigh`) governs how long the server buffers before emitting a partial `...transcription.delta`; higher tiers cut word-error rate and partial flapping at the cost of how quickly interim text appears. We render those partials live, so a sluggish tier is directly felt — hence `low`. It costs nothing in final accuracy or latency: the final `...completed` is transcribed from the whole frozen buffer after our explicit commit regardless, which also makes `delay` a different axis to the client-side `VAD_MAX_SEGMENT_MS` backstop — the two do not interact.

The types for `keywords` and `languages` are hand-written in the provider: the installed `openai` SDK's `AudioTranscription` has no `keywords` field and its `model` union predates `gpt-live-transcribe`. `language?: never` on the local type makes reintroducing the deprecated singular field a compile error.

## OpenAI client-side VAD

The OpenAI provider sends `turn_detection: null` explicitly and segments itself. The explicit `null` matters: omitting the field makes the server apply a default VAD, after which it acks commits but emits no transcription. Every documented `gpt-live-transcribe` example still shows `null`, and whether the model would accept a server-VAD block is unverified — adopting one would be its own change, with the error response checked first.

The old approach committed on a blind 2-second interval, which cut words mid-pause and added up to ~2s of end-of-speech latency. It's replaced by a Silero VAD v5 side-chain (`electron/services/voice/openaiVadWorker.ts`, via the `avr-vad` package) running on a **worker thread** so ONNX inference (~every 32ms) never jitters the Electron main loop. The same 24kHz mono PCM16 stream sent to OpenAI is also fed to the worker, which resamples to Silero's 16kHz internally.

### VAD worker protocol

`electron/services/voice/openaiVadWorkerProtocol.ts`:

- **Main → worker (`VadWorkerInbound`):** `audio` (PCM16 `ArrayBuffer`, transferred not copied) | `destroy`.
- **Worker → main (`VadWorkerOutbound`):** `ready` | `speech-start` | `speech-end` | `error`.

A `VADMisfire` (sub-`minSpeechFrames` blip) is reported as `speech-end` so the provider always returns to not-speaking. Worker defaults: 512-sample frames, ~768ms redemption holdover, 0.5/0.35 positive/negative thresholds — tuned for dictation.

### Commit / barge-in gating (`OpenAITranscriptionProvider`)

- **`speech-end`** → commit the segment (`maybeCommitSegment`) so it streams back.
- **`speech-start`** → **barge-in clear**: drop the silence the server buffered since the last commit (`input_audio_buffer.clear`), then replay a ~300ms pre-roll (`VAD_PRE_ROLL_BYTES`) so the utterance onset survives the clear. This clear is gated on `vadHasEndedSpeech` — the very first speech-start of a (re)connection must **not** clear, because audio captured before the worker was ready might be real speech, not confirmed silence.
- **Backstop** (`VAD_MAX_SEGMENT_MS` = 8s): while speaking, force a commit so long utterances stream and the server buffer stays bounded.
- **Degraded mode:** if the worker fails to spawn / load / crashes, the provider falls back to a periodic 8s backstop commit with no speech gating — dictation still works, just without speech-aware boundaries.
- **`MIN_COMMIT_BYTES`** (4800 ≈ 100ms): OpenAI rejects an undersized commit with a fatal error, so sub-threshold commits are skipped.

Audio always streams to OpenAI continuously regardless of speech state; the VAD only governs _when_ to commit and _when_ to clear, so an under-detecting VAD can never strand audio — the backstop and final commit still flush it.

### Connection resilience

Exponential backoff with full jitter (`RECONNECT_INITIAL_MS` 150 × `1.5^attempt`, capped 3s, up to `RECONNECT_MAX_ATTEMPTS` 5). A ping/pong heartbeat (`HEARTBEAT_INTERVAL_MS` 20s) detects half-open sockets and terminates them. Every connection callback re-checks `sessionId` (and socket identity) so a stale timer/message can't act on a newer session (the #4850/#4851 stale-callback guard). The drain finishes precisely when `pendingCommits` hits zero — each commit yields exactly one `conversation.item.done`, deduped by `completedItemIds` — with `DRAIN_TIMEOUT_MS` (3s) as a backstop.

`classifyOpenAIError` / `classifyCloseCode` are pure, exported, and unit-tested. Transient codes (`rate_limit_exceeded`, `server_error`; close codes 1006/1011/1012/1013) keep the session alive and reconnect; everything else is fatal and tears down.

## Recording modes & session states

`VoiceInputStatus` (`shared/types/voice.ts`): `idle | arming | connecting | recording | paused | reconnecting | finishing | error`. `arming` is renderer-only (the backend never emits it). `isActiveVoiceSession()` deliberately excludes `arming` and `error` so a second hotkey press during arming completes the start instead of being read as a stop.

- **Real-time dictation (toggle mode, the default).** Press to start, press again (or Escape) to stop. `recordingMode: "toggle"`.
- **Push-to-talk.** `recordingMode: "push-to-talk"`. Capture-phase `keydown` records the trigger key's `code`; `keyup` of that key (or of `MetaLeft`/`MetaRight`, because macOS swallows the trigger keyup while a modifier is held) stops. A `blur` listener is the safety net — Chromium dispatches no synthetic keyup on focus loss, so a Cmd+Tab mid-press would otherwise leave the session running. Non-keyboard entry points (palette, menu, agent) fall back to stop-on-second-invoke via `startOrToggle()`; toolbar callers keep calling `toggle()` directly and are unaffected by the mode.
- **Paused.** `pause()` posts `{ type: "setPaused", value: true }` to the worklet (PCM emission stops), freezes the elapsed counter, and keeps the WebSocket open. A 60s auto-stop (`PAUSE_AUTO_STOP_MS`) terminates an abandoned pause so an idle Realtime session isn't billed. `resume()` re-enables emission and folds the paused duration into the elapsed offset. `togglePause()` is exposed as `voiceInput.togglePause`. A renderer subtlety: the local `paused` override is invisible to the backend, so benign backend `recording`/`reconnecting` status ticks are **suppressed** while paused (`onStatus`) to avoid silently exiting pause.
- **Target-follows-focus.** `toggleFocusedPanel()` resolves the dictation target at the instant the hotkey fires (synchronous reads, before any `await`, for #6959/#8887): a pinned `lockedTarget` wins; else if the Assistant input owns focus (`isAssistantFocused()` via `macroFocusStore`, not `panelStore.focusedId`) it routes there; else the focused PTY panel. Only PTY-backed panels are eligible (`panelKindHasPty`) — browsers/dev-preview have no input surface. `recentTargets` (MRU, max 3) and `lockTarget`/`unlockTarget`/`recallRecentTarget` back the context-menu recall affordances.

### Lifecycle teardown triggers

`stop()` is idempotent (single in-flight `stopPromise`) and is also driven by: Escape, PTT keyup/blur, panel close (`panelStore` subscription), project mismatch, system suspend/wake (`systemSleep.onSuspend`/`onWake`), backend `idle` status, and fatal errors. HMR disposes the singleton (`import.meta.hot.dispose → destroy()`) so old `ipcRenderer.on` listeners don't double-fire deltas.

## AI text correction

`electron/services/VoiceCorrectionService.ts`. After a **deliberate** graceful stop (not error, cancel-to-restart, or backend teardown) the renderer fires one whole-passage cleanup over the dictated range (`runCorrection` → `voiceInput.correct` IPC → `VoiceCorrectionService.correct`). It marks the range with the `cm-voice-pending-ai` decoration, sends the full passage to `gpt-5-mini` (default `correctionModel`) via the OpenAI Responses API with a strict JSON schema (`CORRECTION_RESULT_SCHEMA`), and swaps the result in only if the region is still intact and unambiguous — otherwise it keeps the raw text. Best-effort throughout: timeout 7s, any failure leaves the raw text.

Prompt construction lives in `shared/config/voiceCorrection.ts`:

- `CORE_CORRECTION_PROMPT` — fixed correction rules + a `<terms>` phonetic dictionary (`racked → React`, `cube netties → Kubernetes`, etc.).
- `buildCorrectionSystemPrompt(context)` — layers project context, the user's custom dictionary (PREFERRED TERMS), and custom instructions, ending with a fixed guardrail suffix. Ordered fixed-first so the OpenAI prompt cache (`prompt_cache_key`, prefix `voice-correction-v7`) hits. The fixed `CORE_CORRECTION_PROMPT` prefix is kept above OpenAI's 1,024-token cache floor, and `VoiceCorrectionService` sends it as the first `developer` message in the `input` array (not the top-level `instructions` field) so the prefix is actually cache-eligible.
- `CONFIDENCE_SKIP_THRESHOLD` (0.85) — when every word is high-confidence, correction is skipped entirely (currently always skipped in practice since providers emit the stub; the path exists for a future confidence-bearing backend).

`voiceContextKeyterms.ts` (`assembleKeyterms`, `sanitizeOpenAIKeywords`, `formatKeytermPrompt`, branch/project/terminal tokenizers) builds a dynamic keyterm list from the active branch, project name, custom dictionary, and terminal output. The voice-input start handler assembles it at session start and injects it into the snapshotted settings; both providers consume it, and both reconnect paths reuse the frozen list unchanged. `DeepgramTranscriptionProvider` sends it as repeated Nova-3 `keyterm=` URL params. `OpenAITranscriptionProvider` sends it twice over — as the native `transcription.keywords` array and as a bounded `transcription.prompt` (via `formatKeytermPrompt`) — both built from one `sanitizeOpenAIKeywords` pass, so a term rejected from `keywords` can't reach `prompt`.

Sanitising is not optional: the Realtime API rejects the **entire** `session.update` if any keyword contains `<`, `>`, CR, or LF, so one bad term from terminal output (shell redirects, JSX, diff markers) would kill the whole dictation session. Offending terms are dropped whole rather than stripped — deleting `<` from `<div>` yields `div`, a different literal that would bias transcription toward a word the user never had on screen. The 50-term / 100-char caps are Daintree's own conservative bounds, shared with the Deepgram path; OpenAI documents neither limit.

Neither field is sent empty — when nothing survives sanitising, both `keywords` and `prompt` are omitted rather than sent as `[]` / `""`. The `session.update` log deliberately records only shape (model, languages, delay, keyword count, `hasPrompt`, whether `turn_detection` came back null), never contents: keyterms carry the user's branch names and terminal output, and these logs are readable by agents.

### File-link resolution

When AI correction and `resolveFileLinks` are both on, every `complete` utterance is scanned for file-reference commands ("link to the input bar component", "at file…"). Two stages, both gpt-5-nano, both best-effort and abortable via the session `AbortController`:

1. **Detect** — `VoiceCorrectionService.detectFileLinkTokens` runs a permissive regex pre-filter (`FILE_LINK_TRIGGER_RE`, biased to false positives), then the model extracts `{ description }` tokens.
2. **Resolve** — `electron/services/VoiceFileLinkResolver.ts` queries `fileSearchService`, scores candidates with a token-overlap heuristic (high-confidence shortcut at `NL_CONFIDENCE_THRESHOLD` 0.67 with ≥2 matching tokens), else AI-reranks. The handler sends `file_token_resolved` with `@<path>` (or `@?<description>` on miss); the renderer best-effort-replaces the spoken description in the draft.

## Settings, errors, accessibility, IPC

- **Settings** — `VoiceInputSettings` (`shared/types/ipc/api.ts`) is stored under the `voiceInput` key. `getVoiceSettings()` (`electron/ipc/handlers/voiceInput.ts`) merges defaults, migrates legacy `apiKey`/`correctionApiKey` into the unified `openaiApiKey`, normalizes stale provider/model values **without** force-resetting valid user choices (the #9175 fix), and honors `WHISPER_API_KEY` / `DEEPGRAM_API_KEY` env overrides. The UI is `src/components/Settings/VoiceInputSettingsTab.tsx`; saving dispatches `VOICE_INPUT_SETTINGS_CHANGED_EVENT` (`src/lib/voiceInputSettingsEvents.ts`), which makes the renderer service `refreshConfiguration()` live.
- **Error model** — `VoiceInputError` (`shared/types/voice.ts`) is a plain serializable shape (crosses `contextBridge`) with a stable `code` and `severity`. Branch on `code`, not `message`. Transient errors keep the session alive while the main process reconnects (renderer just stores them for tooltip context); fatal errors tear down and surface an action-free error toast.
- **Accessibility** — `src/components/Terminal/VoiceRecordingAnnouncer.tsx` renders an `aria-live="polite"`, `role="status"` `sr-only` region driven by `store.announce(text)`. Status transitions ("Dictation started in …", "paused", "Reconnecting…", errors) are announced once each.
- **IPC channels** — `voice-input:*` in `electron/ipc/channels.ts`; the renderer surface is `window.electron.voiceInput` (`electron/preload.cts`). Request RPCs: `getSettings`, `setSettings`, `start`, `stop`, `flushParagraph`, `checkMicPermission`, `requestMicPermission`, `openMicSettings`, `validateApiKey`, `correct`. Fire-and-forget: `sendAudioChunk` (`ipcRenderer.send`, the audio hot path). Push events: `onTranscriptionDelta`, `onTranscriptionComplete`, `onParagraphBoundary`, `onFileTokenResolved`, `onError`, `onStatus`. The handler registers a `destroyed` listener on the sender so a renderer crash stops the active session.

## Code pointers

| Concern | File |
| --- | --- |
| Renderer capture/session/injection | `src/services/VoiceRecordingService.ts` |
| Renderer store (status, buffers, recents, announcements) | `src/store/voiceRecordingStore.ts` |
| Editor ghost-widget + correcting decorations | `src/components/Terminal/hooks/useVoiceDecorations.ts` |
| Enter-to-submit-after-flush | `src/components/Terminal/hooks/useVoiceWaitSubmit.ts` |
| Actions (toggle, PTT, pause, lock, recall) | `src/services/actions/definitions/voiceActions.ts` |
| Settings UI | `src/components/Settings/VoiceInputSettingsTab.tsx` |
| a11y announcer | `src/components/Terminal/VoiceRecordingAnnouncer.tsx` |
| Main orchestrator (provider selection + forwarding) | `electron/services/VoiceTranscriptionService.ts` |
| Provider interface + neutral event union | `electron/services/voice/TranscriptionProvider.ts` |
| OpenAI Realtime provider | `electron/services/voice/OpenAITranscriptionProvider.ts` |
| Deepgram provider | `electron/services/voice/DeepgramTranscriptionProvider.ts` |
| VAD worker (Silero v5) + protocol | `electron/services/voice/openaiVadWorker.ts`, `openaiVadWorkerProtocol.ts` |
| AI correction service | `electron/services/VoiceCorrectionService.ts` |
| Correction prompts/thresholds | `shared/config/voiceCorrection.ts` |
| File-link resolution | `electron/services/VoiceFileLinkResolver.ts` |
| Dynamic keyterm assembly + OpenAI keyword sanitising | `electron/services/voiceContextKeyterms.ts` |
| Spoken dictation commands ("new paragraph") | `electron/services/voiceDictationCommands.ts` |
| IPC handler (the renderer↔provider seam) | `electron/ipc/handlers/voiceInput.ts` |
| Channel constants | `electron/ipc/channels.ts` |
| Preload surface (`window.electron.voiceInput`) | `electron/preload.cts` |
| Shared types (status, phase, error) | `shared/types/voice.ts` |
