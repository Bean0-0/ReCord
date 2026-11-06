# Testing

## Automated checks

```sh
npm test
npm run typecheck
npm run setup:vencord
npm run build
```

The tests use generated WebRTC protobuf fixtures and temporary files. They cover replay retention, audio decoding and mixing, microphone gating, WAV writing, capture cleanup, file rotation, and voice-join handling. They do not access Discord or a microphone.

The Vencord build checks the renderer and native integration, runs the plugin's lint checks, and builds the desktop bundles. The development checkout is pinned to `383409e6a6ec9008ee8a7496500f1e75f17824d1` when created; an existing checkout is preserved.

## Live checks

Capture has been confirmed in a live call. The scenarios below provide broader coverage across devices and longer sessions. Let participants know before recording.

1. Fully restart Discord after installing the build, enable ReCord, and join a voice call. Confirm the icon turns green, buffered seconds increase, and the call does not reconnect. Enabling ReCord during an existing call should start buffering on the next normal join.
2. With microphone inclusion off, have another participant speak. Save an early clip and another after at least 35 seconds. Confirm the latter contains the previous 30 seconds of incoming audio at the correct speed and channel layout.
3. Stop capture and confirm it stays paused for the call. Enable microphone inclusion and join a test call. Alternate local and remote speech, then check self mute, temporary mute or push-to-talk, hardware mute where available, server mute, and deafen. Listen for missing speech, muted microphone leakage, timing drift, and clipping.
4. Start a recording, save clips while recording, then stop it. Confirm recording starts and stops at the requested times, clip saves do not interrupt it, and buffering continues afterward.
5. Record through a diagnostic file rotation and an output-device change. Check continuity and WAV playback, then inspect memory and temporary disk use during a longer call.
6. Move channels, disconnect and reconnect, disable the plugin, and reload Discord. Confirm capture stops and active recordings are finalized. A new voice stream should start with an empty buffer. Check that newly created diagnostic files are removed once released and pre-existing files are preserved.
7. Exercise the chat-bar button, settings controls, Toolbox actions, `/record`, `/clip`, and Ctrl+Shift+S. The shortcut should fire once per press while Discord is focused. Closing the controls should leave an active recording running with the red status icon visible.

For failures, record the Discord version, Vencord revision, audio subsystem, device layout, and exact error text. Diagnostic dumps can contain microphone audio and metadata.
