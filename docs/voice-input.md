# Voice dictation & transcription pipeline

Daintree can dictate directly into a terminal (or the Daintree Assistant) input: real-time streaming transcription, client-side voice-activity detection (VAD), push-to-talk, a pause state, target-follows-focus routing, and an optional whole-passage AI cleanup pass. The feature spans both processes — microphone capture and editor injection live in the renderer, while WebSocket transport, segmentation, and the OpenAI/Deepgram backends live in the main process. This doc captures how the pieces fit so the flow doesn't have to be reverse-engineered from ~2,500 LOC across the two sides.

For how these IPC channels are registered and dispatched, see [ipc-services.md](./architecture/ipc-services.md).

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
3. **Permission + capture.** `start()` checks/raises OS mic permission via IPC (`checkMicPermission` / `requestMicPermission` / `openMicSettings` — macOS `systemPreferences`, Windows `ms-settings`, Linux best-effort), then `getUserMedia`, then builds a 24kHz `AudioContext`, loads the `pcm-processor` worklet (`/pcm-processor.js`), and connects a silent keep-alive oscillator so Chromium doesn't suspend the capture-only context when backgrounded. Capture starts **eagerly**, before the WebSocket is open, and startup audio passes through three holders in turn: the renderer's per-attempt queue holds chunks until it sends the `voiceInput.start` request (normally nothing, since capture attaches just before; a retarget waiting on the previous session's drain can hold seconds), then sends them straight after it; the session's `preStartAudio` in main (`electron/ipc/handlers/voiceInput.ts`) holds them while it loads the service and assembles keyterms; and the provider's pre-connect buffer holds them until the session is ready. The invoke and the sends share one ordered IPC pipe, and `handleStart` publishes the session with its buffer armed before its first `await`, so no chunk can reach a previous session's provider.
4. **Stream.** Each worklet message carries an `ArrayBuffer` of PCM16. The renderer computes RMS for the UI glow (`setAudioLevel`, throttled to one RAF) and ships the chunk via `voiceInput.sendAudioChunk` (`ipcRenderer.send`, fire-and-forget). Main forwards it to the active provider.
5. **Segment + transcribe.** The provider commits utterance segments (VAD-driven for OpenAI, server-side for Deepgram) and emits `delta` / `complete` events back through the handler.
6. **Inject.** The handler post-processes each `complete` (dictation commands, paragraph splitting, file-link detection) and sends `delta` / `complete` / `paragraph_boundary` / `file_token_resolved` to the renderer. `voiceRecordingService` writes them into the focused terminal's draft through `terminalInputStore`. A completion that ends speech (Deepgram `speech_final`; for OpenAI, the last acknowledged commit with the VAD hearing silence) and ends in "send it" has the phrase stripped, and its last `complete` carries `send`. Deepgram's 300ms endpoint can fall inside a sentence, so main holds such a Deepgram completion for another 700ms (1.5s after a `SpeechStarted`): more words in that time release it with "send it" kept literal and no send, and a stop or a dying provider releases it stripped with no send. While still recording, the renderer hands that to the panel's composer (`voiceRecordingService.onSpokenSend`, registered by `useVoiceWaitSubmit`), which runs Enter's dictation path: stop, wait for the correction, send. A draft under three words, a disabled composer, or no composer only stops dictation. "send it" on a completion cut mid-speech, or right after a negation ("don't send it"), stays literal.
7. **Stop + correct.** A graceful `stop()` first posts `{ type: "flush" }` to the worklet, which sends the partial chunk it is still filling and then a `{ type: "flushed" }` marker and stops emitting. Port messages arrive in order, so once the marker lands every chunk has been forwarded (bounded by `WORKLET_FLUSH_TIMEOUT_MS`). Only then is capture torn down and the remote stop sent, so it reaches main behind the last chunk. Main drains the provider gracefully. A stop that lands while the session is still `starting` (loading the service or assembling keyterms) with audio already held waits for the start to hand that audio to its provider, then drains it through the provider's stop-before-ready path instead of discarding it. With nothing held, the session ends as `cancelled` before any socket opens. The renderer then flushes any trailing interim text and — if AI correction is enabled and the stop was deliberate — fires one whole-passage correction pass (`runCorrection`) over the dictated range.

### Text-injection model (important)

Interim `delta` text is **never** written into the editor document. It accumulates only in `liveText` in `voiceRecordingStore` (or, for a delta flagged `replace`, overwrites its item's preview: Deepgram's interims are whole revisions of the span since its last final, not additions) and is rendered as a CodeMirror ghost-widget decoration (`useVoiceDecorations`, `src/components/Terminal/hooks/useVoiceDecorations.ts`), outside the doc model. Only a `complete` event writes real text, so the editor's undo history records **one transaction per utterance** rather than one per token (#9172). The service tracks several draft offsets per panel buffer to splice correctly:

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
| `OpenAITranscriptionProvider` | `false` | `wss://api.openai.com/v1/realtime?intent=transcription`, model `gpt-live-transcribe` | base64 JSON `input_audio_buffer.append` | client-side Silero VAD process + 8s backstop | ping/pong heartbeat (20s idle, seconds once audio is unanswered) |
| `DeepgramTranscriptionProvider` | `true` | `wss://api.deepgram.com/v1/listen`, model `nova-3`, `punctuate` + `smart_format` + `interim_results` | raw binary frames, `linear16` @ 24kHz | server-side `endpointing=300`; each span between finals is one item | `KeepAlive` frame (5s) |

Both buffer up to `AUDIO_BUFFER_MAX_CHUNKS` (150) chunks / `AUDIO_BUFFER_MAX_BYTES` (720,000 bytes, 15s) while connecting or reconnecting, then flush on session-ready. The cap matches the renderer's own startup queue (`MAX_QUEUED_CHUNKS`), and the IPC handler's pre-start buffer uses the same one. A stop before the session is ready waits up to `STOP_CONNECT_TIMEOUT_MS` (3s) for it, then flushes, commits and drains. OpenAI skips a final commit under 100ms (`MIN_COMMIT_BYTES`), which it would reject. WebSocket URLs accept env overrides (`DAINTREE_REALTIME_WS_URL`, `DAINTREE_DEEPGRAM_WS_URL`) for testing.

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

The old approach committed on a blind 2-second interval, which cut words mid-pause and added up to ~2s of end-of-speech latency. It's replaced by a Silero VAD v5 side-chain (`electron/services/voice/openaiVadWorker.ts`, via the `avr-vad` package) running in a dedicated `utilityProcess` child (`openaiVadProcess.ts`, one per voice session, `serviceName` `daintree-voice-vad`) so ONNX inference (~every 32ms) never jitters the Electron main loop — and, since ONNX Runtime can abort in native code (#12577), so an abort ends that child instead of main. The same 24kHz mono PCM16 stream sent to OpenAI is also fed to the child, which resamples to Silero's 16kHz internally.

Retiring a VAD posts `destroy` and waits: the child drains its in-flight model load and inference, releases the ONNX session, reports `drained` and exits 0. A child still alive `VAD_RETIRE_KILL_MS` (3s) later gets a raw SIGKILL — `UtilityProcess.kill()` blocks main on macOS (#11069), and only that process dies either way. App quit gives outstanding drains `VAD_DRAIN_BUDGET_MS` (1s) inside the cleanup phase. Any exit the provider did not ask for, like a native abort, drops it into degraded mode: no speech events, commits on the `VAD_MAX_SEGMENT_MS` backstop alone, dictation keeps working.

### VAD worker protocol

`electron/services/voice/openaiVadWorkerProtocol.ts`:

- **Main → VAD (`VadWorkerInbound`):** `audio` (PCM16 `ArrayBuffer`, structured-cloned across the process boundary) | `destroy`.
- **VAD → main (`VadWorkerOutbound`):** `ready` | `speech-start` | `speech-end` | `drained` | `error`.

A `VADMisfire` (sub-`minSpeechFrames` blip) is reported as `speech-end` so the provider always returns to not-speaking. VAD defaults: 512-sample frames, ~768ms redemption holdover, 0.5/0.35 positive/negative thresholds — tuned for dictation.

### Commit / barge-in gating (`OpenAITranscriptionProvider`)

- **`speech-end`** → commit the segment (`maybeCommitSegment`) so it streams back.
- **`speech-start`** → **barge-in clear**: drop the silence the server buffered since the last commit (`input_audio_buffer.clear`), then replay a ~300ms pre-roll (`VAD_PRE_ROLL_BYTES`) so the utterance onset survives the clear. This clear is gated on `vadHasEndedSpeech` — the very first speech-start of a (re)connection must **not** clear, because audio captured before the worker was ready might be real speech, not confirmed silence.
- **Backstop** (`VAD_MAX_SEGMENT_MS` = 8s): while speaking, force a commit so long utterances stream and the server buffer stays bounded.
- **Degraded mode:** if the worker fails to spawn / load / crashes, the provider falls back to a periodic 8s backstop commit with no speech gating — dictation still works, just without speech-aware boundaries.
- **`MIN_COMMIT_BYTES`** (4800 ≈ 100ms): OpenAI rejects an undersized commit with a fatal error, so sub-threshold commits are skipped.

Audio always streams to OpenAI continuously regardless of speech state; the VAD only governs _when_ to commit and _when_ to clear, so an under-detecting VAD can never strand audio — the backstop and final commit still flush it.

### Connection resilience

Exponential backoff with full jitter (`RECONNECT_INITIAL_MS` 150 × `1.5^attempt`, capped 3s, up to `RECONNECT_MAX_ATTEMPTS` 5). A ping/pong heartbeat detects half-open sockets and terminates them. It checks every `HEARTBEAT_TICK_MS` (2s): idle, it pings every 20s and allows 20s for the answer. Once audio has gone out since the server was last heard from, it pings at once and allows `HEARTBEAT_ACTIVE_MS` (3s), so a dead socket that is swallowing speech is noticed in about 8s while streaming. Any server frame counts as an answer. Each ping also gets the time its backlog needs at `HEARTBEAT_FLOOR_BYTES_PER_MS` (64, the audio stream's own wire rate): the bytes sent since the last ping a pong answered, which TCP ordering proves delivered. A ping queued behind seconds of reconnect flush on a slow uplink therefore isn't a false timeout, while steady streaming adds only a couple of seconds. Write completion isn't used, since Node batches buffered frames and completes them together. Every connection callback re-checks `sessionId` and socket identity before it touches shared state or timers, so a stale timer, message or late close can't act on a newer connection (the #4850/#4851 stale-callback guard). The drain finishes precisely when `pendingCommits` hits zero. Each commit yields exactly one terminal result: `...transcription.completed`, `...transcription.failed`, or a `conversation.item.done` that carries text (an empty `.done` is a placeholder and leaves the drain waiting). Results are deduped by `completedItemIds`, with `DRAIN_TIMEOUT_MS` (3s) as a backstop.

Audio sent since the server last acknowledged a commit (`input_audio_buffer.committed`) is kept in a replay ledger: unacknowledged commits as segments, plus the uncommitted tail. On a drop it survives the reconnect and is resent first, each segment followed by its commit, then the reconnect-window audio. An acknowledged commit belongs to the server; its item is settled with its interim text on a drop, as before, and its audio is never resent, so nothing is transcribed twice. A tail the VAD had already called silence is cut to its last 2s (`REPLAY_SILENCE_KEEP_BYTES`), and the ledger is capped at `REPLAY_MAX_BYTES` (30s), dropping the oldest audio first. The new connection's VAD never hears the replayed audio, so a one-shot `VAD_MAX_SEGMENT_MS` backstop commits it if no live speech takes over. A drop while the stop is draining doesn't reconnect: what was acknowledged settles, and the rest is lost.

`classifyOpenAIError` / `classifyCloseCode` are pure, exported, and unit-tested. Transient codes (`rate_limit_exceeded`, `server_error`; close codes 1006/1011/1012/1013) keep the session alive and reconnect; everything else is fatal and tears down.

## Recording modes & session states

`VoiceInputStatus` (`shared/types/voice.ts`): `idle | arming | connecting | recording | paused | reconnecting | finishing | error`. `arming` is renderer-only (the backend never emits it). `isActiveVoiceSession()` deliberately excludes `arming` and `error` so a second hotkey press during arming completes the start instead of being read as a stop.

- **Real-time dictation (toggle mode, the default).** Press to start, press again (or Escape) to stop. `recordingMode: "toggle"`.
- **Push-to-talk.** `recordingMode: "push-to-talk"`. Capture-phase `keydown` records the trigger key's `code`; `keyup` of that key (or of `MetaLeft`/`MetaRight`, because macOS swallows the trigger keyup while a modifier is held) stops. A `blur` listener is the safety net — Chromium dispatches no synthetic keyup on focus loss, so a Cmd+Tab mid-press would otherwise leave the session running. Non-keyboard entry points (palette, menu, agent) fall back to stop-on-second-invoke via `startOrToggle()`; toolbar callers keep calling `toggle()` directly and are unaffected by the mode.
- **Paused.** `pause()` posts `{ type: "setPaused", value: true }` to the worklet (PCM emission stops), freezes the elapsed counter, and keeps the WebSocket open. A 60s auto-stop (`PAUSE_AUTO_STOP_MS`) terminates an abandoned pause so an idle Realtime session isn't billed. `resume()` re-enables emission and folds the paused duration into the elapsed offset. `togglePause()` is exposed as `voiceInput.togglePause`. A renderer subtlety: the local `paused` override is invisible to the backend, so benign backend `recording`/`reconnecting` status ticks are **suppressed** while paused (`onStatus`) to avoid silently exiting pause.
- **Target-follows-focus.** The hotkey is a global stop first: if a session is active (or arming) anywhere, `toggleFocusedPanel()` ends it via `stopAnySession()` without consulting focus or the lock, so a press never moves a recording (#12832). Only when idle does it resolve the dictation target at the instant the hotkey fires (synchronous reads, before any `await`, for #6959/#8887): a pinned `lockedTarget` wins; else if the Assistant input owns focus (`isAssistantFocused()` via `macroFocusStore`, not `panelStore.focusedId`) it routes there; else the focused PTY panel. Only PTY-backed panels are eligible (`panelKindHasPty`) — browsers/dev-preview have no input surface. `recentTargets` (MRU, max 3) and `lockTarget`/`unlockTarget`/`recallRecentTarget` back the context-menu recall affordances.

### Lifecycle teardown triggers

`stop()` is idempotent (single in-flight `stopPromise`) and is also driven by: Escape, PTT keyup/blur, panel close (`panelStore` subscription), project mismatch, system suspend/wake (`systemSleep.onSuspend`/`onWake`), backend `idle` status, and fatal errors. HMR disposes the singleton (`import.meta.hot.dispose → destroy()`) so old `ipcRenderer.on` listeners don't double-fire deltas.

## AI text correction

`electron/services/VoiceCorrectionService.ts`. On by default, and effective whenever an OpenAI API key is configured (migration 037 turned it on once for existing installs). After a **deliberate** graceful stop (not error, cancel-to-restart, or backend teardown) the renderer fires one whole-passage cleanup over the dictated range (`runCorrection` → `voiceInput.correct` IPC → `VoiceCorrectionService.correct`). It marks the range with the `cm-voice-pending-ai` decoration, sends the full passage to `gpt-6-luna` (`VOICE_DICTATION_AI_MODEL`; a stored `correctionModel` is forced back to it on read) via the OpenAI Responses API with a strict JSON schema (`CORRECTION_RESULT_SCHEMA`), and swaps the result in only if the region is still intact and unambiguous — otherwise it keeps the raw text. Best-effort throughout: the timeout is 7s for a short passage and scales with length up to 60s, and any failure leaves the raw text.

Prompt construction lives in `shared/config/voiceCorrection.ts`:

- `CORE_CORRECTION_PROMPT` — fixed cleanup rules (fillers and false starts, explicit self-corrections, counted lists laid out as numbered lists, mishearings) + a `<terms>` phonetic dictionary (`cube netties → Kubernetes`, `type script → TypeScript`, etc.). Aliases that are ordinary English ("rejects", "jot", "roll up") are kept out of the table, and the rest apply only where the words make no sense as plain English.
- `buildCorrectionSystemPrompt(context)` — layers project context, the user's custom dictionary (PREFERRED TERMS), and custom instructions, ending with a fixed guardrail suffix. Ordered fixed-first so the OpenAI prompt cache (`prompt_cache_key`, prefix `voice-correction-v9`) hits. The fixed `CORE_CORRECTION_PROMPT` prefix is kept above OpenAI's 1,024-token cache floor, and `VoiceCorrectionService` sends it as the first `developer` message in the `input` array (not the top-level `instructions` field) so the prefix is actually cache-eligible.
- `CONFIDENCE_SKIP_THRESHOLD` (0.85) — the skip guard only fires when the request carries an empty `uncertainWords` array alongside a `minConfidence` above the threshold. The renderer never sends `uncertainWords`, so the skip cannot fire today and correction runs on every deliberate stop when it is enabled; the path exists for a future confidence-bearing backend.

Meaning beats polish, so `VoiceCorrectionService` checks every replacement before it is applied (`electron/services/voiceCorrectionGuard.ts`) and keeps the exact raw text when one fails. References, backticked spans, URLs, paths, flags and numbers (digits, spoken English numbers and Han numerals) must come back byte for byte and in order, and the model may not invent a new flag, reference, URL or backticked span; a negation may not be added, dropped or moved to another word; and a result that adds or removes more words than a cleanup would (15% of the passage, with a small floor for short ones) is treated as a rewrite. Two edits may drop more, each only where the raw text shows why: the words an explicit self-correction ("no wait", "scratch that", "I mean", "or rather", a bare "no" or "sorry" between commas) takes back, and the counting words of a spoken list the cleanup laid out as one. Dropped words are located by aligning the two passages, the retracted words start at the last copy of the replacement's first word, and neither allowance may drop a negation, a number or a protected span, so such a self-correction is left as spoken. Negations are only recognised in English, and a single swapped word still gets through: the checks are structural, not semantic. A replacement the model marks low-confidence is never applied. A passage over 12,000 characters is deliberately left raw, the output budget scales with the passage, and a reply cut off at that budget (`status: "incomplete"`) is discarded whole rather than parsed. Rejections log a reason code and lengths, never the text.

`electron/services/__tests__/fixtures/dictatedPrompts.ts` holds dictated agent prompts with their expected cleanups. The guard tests check every expected cleanup (and every worked example in the prompt) passes the guard; `npm run test:integration -- VoiceCleanup.eval` judges the live prompt against them with an `OPENAI_API_KEY`.

`voiceContextKeyterms.ts` (`assembleKeyterms`, `sanitizeOpenAIKeywords`, `formatKeytermPrompt`, branch/project/terminal tokenizers) builds a dynamic keyterm list from the target project's vocabulary and the custom dictionary plus four sources tied to the terminal being dictated into, which the renderer names in `voiceInput.start(sessionId, { terminalId })`. In rank order: its owning project's name; names from that project's repository; the branch of the worktree it's filed under; and identifiers from its recent output. The repository tier (`voiceRepoKeyterms.ts`) reads the root and workspace package names, top-level directory names and dependency names from the owning project's root, derives them fresh per session and never stores them, and adds at most 6 terms. Its reads are bounded: a manifest is resolved through symlinks and read only when it is a regular file inside the project root of at most 256KB, only the first 20 workspace patterns are tried (`dir/*` and literal paths, either separator, nothing that climbs out), and no read starts once the 500ms assembly budget is spent. The project vocabulary and the dictionary share one budget of at most 36 of the 50 slots, project terms first (`RESERVED_CONTEXT_KEYTERMS` is 14), so the project, repository and branch tiers always fit. Every assembled term, repository names included, is sent to the transcription provider. A terminal main doesn't track, or one another project owns than the requesting view, contributes nothing. Derived terms pass through `voiceKeytermSecrets.ts` first: a line holding a credential (a known secret format, a key-shaped run, or a value assigned to a credential name) is emptied along with the line after it, and opaque IDs and bare credential names are blanked from the rest. The project vocabulary and the dictionary are hand-entered and aren't filtered. The voice-input start handler assembles it at session start and injects it into the snapshotted settings; both providers consume it, and both reconnect paths reuse the frozen list unchanged. `DeepgramTranscriptionProvider` sends it as repeated Nova-3 `keyterm=` URL params. `OpenAITranscriptionProvider` sends it twice over — as the native `transcription.keywords` array and as a bounded `transcription.prompt` (via `formatKeytermPrompt`) — both built from one `sanitizeOpenAIKeywords` pass, so a term rejected from `keywords` can't reach `prompt`.

Sanitising is not optional: the Realtime API rejects the **entire** `session.update` if any keyword contains `<`, `>`, CR, or LF, so one bad term from terminal output (shell redirects, JSX, diff markers) would kill the whole dictation session. Offending terms are dropped whole rather than stripped — deleting `<` from `<div>` yields `div`, a different literal that would bias transcription toward a word the user never had on screen. The 50-term / 100-char caps are Daintree's own conservative bounds, shared with the Deepgram path; OpenAI documents neither limit.

Neither field is sent empty — when nothing survives sanitising, both `keywords` and `prompt` are omitted rather than sent as `[]` / `""`. The `session.update` log deliberately records only shape (model, languages, delay, keyword count, `hasPrompt`, whether `turn_detection` came back null), never contents: keyterms carry the user's branch names, repository names and terminal output, and these logs are readable by agents.

### File-link resolution

When AI correction and `resolveFileLinks` are both on, every `complete` utterance is scanned for file-reference commands ("link to the input bar component", "at file…"). Two stages, both `gpt-6-luna`, both best-effort and abortable via the session `AbortController`:

1. **Detect** — `VoiceCorrectionService.detectFileLinkTokens` runs a permissive regex pre-filter (`FILE_LINK_TRIGGER_RE`, biased to false positives), then the model extracts `{ description }` tokens.
2. **Resolve** — `electron/services/VoiceFileLinkResolver.ts` queries `fileSearchService`, scores candidates with a token-overlap heuristic (high-confidence shortcut at `NL_CONFIDENCE_THRESHOLD` 0.67 with ≥2 matching tokens), else AI-reranks. The handler sends `file_token_resolved` with `@<path>` (or `@?<description>` on miss); the renderer best-effort-replaces the spoken description in the draft.

## Settings, errors, accessibility, IPC

- **Settings** — `VoiceInputSettings` (`shared/types/ipc/api.ts`) is stored under the `voiceInput` key. `getVoiceSettings()` (`electron/ipc/handlers/voiceInput.ts`) merges defaults, migrates legacy `apiKey`/`correctionApiKey` into the unified `openaiApiKey`, normalizes stale provider/model values **without** force-resetting valid user choices (the #9175 fix), and honors `WHISPER_API_KEY` / `DEEPGRAM_API_KEY` env overrides. `setSettings` writes only the fields it lists in `WRITABLE_VOICE_FIELDS`. The UI is `src/components/Settings/VoiceInputSettingsTab.tsx`; saving dispatches `VOICE_INPUT_SETTINGS_CHANGED_EVENT` (`src/lib/voiceInputSettingsEvents.ts`), which makes the renderer service `refreshConfiguration()` live.
- **Dictionary** — `dictionary` holds `VoiceDictionaryEntry` records (written `term`, `heardAs` forms, `source` of `manual` / `learned` / `imported`, `addedAt`), oldest first, unique ignoring case. Main owns it and the `suggestedDictionary` queue: the renderer changes them only through `window.electron.voiceDictionary` (`add`, `remove`, `update`, `acceptSuggestion`, `dismissSuggestion`, `recordSuggestions`), each one synchronous read-modify-write in `electron/ipc/handlers/voiceDictionary.ts` that returns the state main now holds. The pure model is `shared/utils/voiceDictionary.ts`; keyterm assembly and correction still take the plain list of written terms (`dictionaryTerms`). Migration 036 moved the old `customDictionary` word list into entries.
- **Project vocabulary** — each project has its own entries in `ProjectSettings.voiceDictionary`, edited under Project settings → Context and changed only through `voiceDictionary.getProject` / `addToProject` / `removeFromProject` / `updateInProject`. A project that keeps its settings in the repo reads and writes the vocabulary in `.daintree/settings.json` (committed as `{ term, heardAs }`), so a teammate's terms arrive with a pull; any other project keeps it locally (`electron/services/projectVoiceDictionary.ts`). A whole-settings save keeps the stored list rather than its own copy, carrying the committed field over verbatim from any file that parses. Turning in-repo settings on adopts a committed list when there is one and commits the local list otherwise; turning them off copies the list in use into the local one. A session uses the vocabulary of the project that owns the target panel (none for a terminal another project owns than the asking view): its terms take the dictionary keyterm budget ahead of the global list, and correction gets `sessionDictionary(global, project)`, project entries first.
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
| VAD child lifecycle (fork, retire, SIGKILL backstop, quit drain) | `electron/services/voice/openaiVadProcess.ts` |
| VAD entry (Silero v5) + protocol | `electron/services/voice/openaiVadWorker.ts`, `openaiVadWorkerProtocol.ts` |
| AI correction service | `electron/services/VoiceCorrectionService.ts` |
| Correction prompts/thresholds | `shared/config/voiceCorrection.ts` |
| File-link resolution | `electron/services/VoiceFileLinkResolver.ts` |
| Dynamic keyterm assembly + OpenAI keyword sanitising | `electron/services/voiceContextKeyterms.ts` |
| Repository-derived keyterm names (package, workspace, directory, dependency) | `electron/services/voiceRepoKeyterms.ts` |
| Spoken dictation commands ("new paragraph", "new line", "send it") | `electron/services/voiceDictationCommands.ts` |
| IPC handler (the renderer↔provider seam) | `electron/ipc/handlers/voiceInput.ts` |
| Channel constants | `electron/ipc/channels.ts` |
| Preload surface (`window.electron.voiceInput`) | `electron/preload.cts` |
| Shared types (status, phase, error) | `shared/types/voice.ts` |
