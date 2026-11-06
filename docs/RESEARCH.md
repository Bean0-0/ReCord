# ReCord implementation research

Inspected November 6, 2026. This document records the initial investigation. A first implementation now lives in `plugin/`; see the [README](../README.md) for its current capabilities and limits.

## Conclusion

A custom Vencord plugin for recording voice calls and saving the previous 30 seconds looks feasible on the official Discord desktop client. The first milestone should validate audio capture in a test call on the current client. Static inspection establishes a plausible route, but does not establish that a complete recording works.

An existing userplugin, [VcRewind](https://github.com/fizzexual/VcRewind), already implements rolling clips with optional microphone audio. It is the strongest reference found. Its README reports verification on September 6, 2026; that is the author's claim, not a test performed for ReCord. Its source does not implement a full-call start/stop recorder.

Recommended initial target: official Discord desktop on Windows. Browser Discord and Vesktop require a different capture backend.

## How Vencord plugins work

- Custom plugins live in a Vencord source checkout under `src/userplugins/`. They are bundled when Vencord builds; the standard release does not dynamically load this repository.
- An `index.ts` or `index.tsx` exports `definePlugin({ name, description, authors, start, stop, ... })`. Vencord supplies settings, commands, notifications, React integration, Flux subscriptions, and access to Discord modules through Webpack helpers.
- Renderer code runs with browser APIs. An optional `native.ts` runs in Electron's main process and exports asynchronous IPC helpers through `VencordNative.pluginHelpers.ReCord`. This is where tightly scoped filesystem access belongs.
- Regex patches can add a button beside Discord's voice controls. Start with commands or Vencord Toolbox actions so the capture prototype does not depend on a UI patch. Native changes require a full Discord restart.
- For the proposed native backend, use `src/userplugins/reCord.discordDesktop/`. Current Vencord distinguishes `.discordDesktop` from `.desktop`: the latter also allows Vesktop, which lacks Discord's native voice module.

Sources: [plugin setup](https://docs.vencord.dev/plugins/), [plugin API](https://docs.vencord.dev/plugins/common/), [custom installation](https://docs.vencord.dev/installing/custom-plugins/), [native helpers](https://docs.vencord.dev/plugins/native/), [patches](https://docs.vencord.dev/plugins/patches/), [build platform filtering](https://github.com/Vendicated/Vencord/blob/383409e6a6ec9008ee8a7496500f1e75f17824d1/scripts/build/common.mjs#L176).

## Capturing the call

Vencord has useful recording examples, but no general call-recording API was found in its current plugin API:

- [VoiceMessages/DesktopRecorder.tsx](https://github.com/Vendicated/Vencord/blob/383409e6a6ec9008ee8a7496500f1e75f17824d1/src/plugins/voiceMessages/DesktopRecorder.tsx) uses `discord_voice.startLocalAudioRecording` with the selected input device. This records microphone input; it does not demonstrate recording everyone in the call.
- [VolumeBooster](https://github.com/Vendicated/Vencord/blob/383409e6a6ec9008ee8a7496500f1e75f17824d1/src/plugins/volumeBooster/index.ts) accesses received `MediaStream` audio specifically on web/Vesktop. That path is explicitly excluded on official Discord desktop, so a browser audio-element approach cannot simply be assumed to work there.
- Discord has internal Clips APIs, but their presence does not establish a supported, audio-only VC recorder. They are not the recommended dependency for the first prototype.

### Most promising desktop backend: AEC dumps

VcRewind enables Discord's WebRTC echo-cancellation diagnostic dump using `MEDIA_ENGINE_SET_AEC_DUMP`. Its native helper reads files under Discord's `module_data/discord_voice` directory. Its parser extracts incoming playout audio and microphone audio, mixes them, selects the requested tail, and exports WAV or Ogg Opus.

The inspected Vencord types expose `setAecDump(enabled)` and `getAecDump()`. A read-only inspection of the locally installed Discord 1.0.9267 voice module found the `setAecDump` symbol and `aecdump` strings in its native binary. This supports testing the approach; it does not verify the dump format, channel layout, timing, mute behavior, or runtime availability.

Important consequences for ReCord:

- This uses an internal debug facility, so Discord updates can break it. Check capabilities at startup and show a clear error if capture is unavailable.
- The debug facility writes files to disk. A 30-second export window does not mean only 30 seconds of audio exists on disk. File rotation and cleanup need separate limits.
- Dump records can contain raw and processed microphone audio. An “include microphone” export setting does not prevent microphone data from being present in temporary dumps. Verify mute behavior rather than assuming it.
- Treat dumps as shared Discord diagnostic state. Track the capture state and files belonging to the current session; avoid indiscriminately deleting every existing dump or changing a diagnostic session another tool owns.
- This yields a mixed incoming stream, not individual tracks for each speaker. The first version should record what the user hears, with optional inclusion of their own transmitted microphone. Validate soundboards and shared-stream audio separately.

Reference source: [capture lifecycle and UI](https://github.com/fizzexual/VcRewind/blob/a9b6aeaf1e21e730d6cba2e646a6398cd73968ae/index.tsx), [native helpers](https://github.com/fizzexual/VcRewind/blob/a9b6aeaf1e21e730d6cba2e646a6398cd73968ae/native.ts), [dump parser](https://github.com/fizzexual/VcRewind/blob/a9b6aeaf1e21e730d6cba2e646a6398cd73968ae/dump.ts), [encoding](https://github.com/fizzexual/VcRewind/blob/a9b6aeaf1e21e730d6cba2e646a6398cd73968ae/ogg.ts). The inspected source headers and README declare GPL-3.0-or-later; preserve attribution and license terms if adapting code.

## Proposed ReCord implementation

1. **Prove capture first.** Build a minimal desktop userplugin with explicit capture controls. In a test call, verify incoming audio plus local microphone, including muted and deafened periods. Confirm dump location, format, rotation, sample rates, and partial-record behavior on this installation.
2. **Build the capture service.** Incrementally read new dump records, handle incomplete records while files are being written, and use bounded parsing in a worker if needed to avoid blocking Electron's main process. Derive timing and channel information from the actual data; handle device changes and gaps explicitly.
3. **Implement replay buffering.** Keep the latest 30 seconds of normalized PCM in a bounded ring buffer. Saving a clip snapshots that buffer without stopping capture. If capture has run for less than 30 seconds, save the available duration. Buffering must already be active before the moment happens.
4. **Implement full recording separately.** Feed the same capture pipeline into a streaming recording writer between Start and Stop. Keep recording independent of replay-buffer eviction. Segment long recordings as necessary, recover incomplete sessions, and surface disk-full/write errors.
5. **Add output formats.** Start with WAV to validate audio and timing. Add compressed Opus after capture is reliable, with codec capability detection and a WAV fallback. Do not accumulate an entire long call in memory. Do not create clips by blindly discarding earlier `MediaRecorder` WebM blobs: later chunks may require the original container header and remuxing.
6. **Add controls.** Provide Clip last 30 seconds, Start/Stop recording, buffering status, a recording timer, microphone inclusion, and output selection. Add a voice-panel button after the core works. VcRewind's keybind uses `window.keydown`, so it only handles keys delivered to the Discord window; a shortcut that works during a game needs separate global-shortcut integration.
7. **Finish lifecycle handling.** Handle joining, leaving, channel switching, reconnects, reloads, disabling the plugin, and restarting Discord. Reset replay state between calls and finalize or recover active recordings. Cleanup should stop only capture ReCord owns and remove its temporary data.

Keep native IPC narrow: read only the expected dump files, validate arguments and lengths, and save to a user-selected destination or constrained recording directory. Use Vencord's existing save-file helper for clip downloads where possible. Capture should be explicit and visibly indicated; participants need to know when a call is recorded. No automatic upload is needed for the first version.

Suggested modules: `index.tsx` for Vencord integration and controls, `settings.ts`, `native.ts`, `capture.ts` for incremental parsing, `buffer.ts`, `recording.ts`, and `encoding.ts`. The exact split can stay small until capture is proven.

## Development setup and validation

This machine has Git 2.43.0, Node 24.14.1, and pnpm 10.33.2, plus installed Discord and Vencord directories. A Vencord source/development installation was not established during this inspection. The inspected Vencord revision requires Node >=22 and declares `pnpm@12.15.0`; use its declared package manager when preparing a checkout.

Keep this repository as the plugin source, and copy or link its plugin directory into a separate Vencord checkout. The documented build flow is:

```text
pnpm install --frozen-lockfile
pnpm build --dev
pnpm inject
```

Then fully restart Discord and enable ReCord. Those commands are setup instructions; they were not run against the installed client during this research.

Validation should include parser fixtures with truncated and malformed records, exact replay duration, early clips, repeated clips while recording, file rotation, changing sample rates/channel counts, mute/deafen, reconnects and channel switches, and a long recording with bounded memory/disk behavior. Type-check and build inside the Vencord checkout. A live call remains necessary to validate the private capture API.

No plugin was installed or enabled, no call was joined, and no audio capture was started as part of this inspection.

Inspected revisions: Vencord `383409e6a6ec9008ee8a7496500f1e75f17824d1`; VcRewind `a9b6aeaf1e21e730d6cba2e646a6398cd73968ae`.


## November 6, 2026 capture failure follow-up

The user retested revision `2026-11-06.1` after a full restart with other participants speaking. The timeout reported zero dump files, zero bytes read, and zero frames in the expected Discord module directory. A read-only inspection of the locally installed Discord 1.0.9267 voice module found the following native behavior: the enabled path of `setAecDump` changes an atomic flag without opening a writer; the local-user audio stream creation path calls the writer startup routine. The disabled path stops the writer. This explains why enabling diagnostics after the voice stream already exists can fail to create any files.

Revision `2026-11-06.2` enabled diagnostics before briefly reconnecting the existing RTC connection. The controls disclose the interruption. Its initial reconnect can preserve capture in the same channel; subsequent connection losses, moves, and leaves stop capture as before. No reconnect or capture was initiated by the coding agent during this investigation. This workaround was subsequently removed in favor of the automatic join hook below.


## Automatic buffering before the voice stream

The reconnect workaround was removed after the user reported the visible leave/rejoin. The cached desktop renderer has empty `startAecDump` / `stopAecDump` methods; its implemented diagnostic control is `setAecDump`. No supported public method to start this diagnostic writer inside an existing native call was identified in the inspected interfaces. The native voice stream startup remains the useful trigger for this backend.

The RTC connection's `_connectMediaEngineWithEndpoint(endpoint, ready)` is invoked by ready/SFU event handlers without using its return value. Revision `2026-11-06.3` patches this method to await ReCord's capture preparation before creating the stream, only for normal voice connections. Preparation establishes the native file baseline, enables diagnostics, and starts polling. The original join then continues. If its socket changed while waiting, the stale continuation is discarded. A two-second timeout cancels late setup and permits the normal join even if capture is unavailable. No reconnect method is called.

Recording and clip saves use the same live capture session. Stop capture pauses the current call; the next normal voice join prepares a fresh session. The patch matches once in the locally installed cached JavaScript and the patched source compiles. Synthetic tests verify file creation after baseline preparation, cancellation, failure/timeout behavior, and recording without stream recreation. On November 6, 2026, the user confirmed that capture and the other functionality work with this update. Broader device and long-session coverage remains in the testing checklist.
