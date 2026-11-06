# Testing

## Automated checks

```sh
npm test
npm run typecheck
npm run setup:vencord
npm run build
```

The tests use synthetic PCM and temporary output directories. They cover replay retention, pipe framing, audio mixing and mute gating, WAV writing, bounded buffering, capture failures, and voice-join handling. They do not access Discord or a microphone.

The Windows capture helper can also be tested with generated, quiet tones:

```sh
npm run test:loopback
```

This plays tones from two separate processes, captures one process tree, and checks the other is excluded. It verifies that buffering creates no audio file before a clip is saved. It requires a built helper and an audio output device; it does not use a microphone.

The Vencord build compiles the helper with the Visual Studio C++ tools, checks the renderer and native integration, runs the plugin's lint checks, and builds the desktop bundles. The development checkout is pinned to `383409e6a6ec9008ee8a7496500f1e75f17824d1` when created; an existing checkout is preserved.

## Live checks

The process-loopback capture path needs a live call test. Let participants know before recording.

1. Fully quit and reopen Discord after installing the build, enable ReCord, and join a voice call. Confirm buffered seconds increase and the call does not reconnect. Enabling ReCord during an existing call should start buffering on the next normal join.
2. With microphone inclusion off, have another participant speak. Save an early clip and another after at least 35 seconds. Confirm the latter contains the previous 30 seconds of Discord audio at the correct speed and channel layout. Confirm audio from another application is excluded.
3. Stop capture and confirm it stays paused for the call. Enable microphone inclusion and join a test call. Alternate local and remote speech, then check self mute, temporary mute or push-to-talk, hardware mute where available, server mute, and deafen. Listen for missing speech, muted microphone leakage, timing drift, and clipping. Confirm changing the selected microphone stops capture.
4. Start a recording, save clips while recording, then stop it. Confirm recording starts and stops at the requested times, clip saves do not interrupt it, and buffering continues afterward.
5. Change the output device and record a longer call. Check continuity, WAV playback, and memory use. Confirm buffering creates no diagnostic audio files.
6. Move channels, disconnect and reconnect, disable the plugin, and reload Discord. Confirm capture stops and active recordings are finalized. A new voice stream should start with an empty buffer.
7. Exercise the chat-bar button, settings controls, Toolbox actions, `/record`, `/clip`, and Ctrl+Shift+S. The shortcut should fire once per press while Discord is focused. Closing the controls should leave an active recording running with the red status icon visible.

For failures, record the Discord version, Vencord revision, audio subsystem, device layout, and exact error text.
