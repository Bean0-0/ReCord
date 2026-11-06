# Capture internals

ReCord is a Vencord userplugin for official Discord desktop. Its renderer integrates with Discord's voice state and controls; its native helpers read diagnostic files and write recordings. Vencord bundles the plugin from `src/userplugins/reCord.discordDesktop/`.

## Starting capture

Discord's native voice engine can write WebRTC echo-cancellation diagnostic dumps. ReCord enables this through the `MEDIA_ENGINE_SET_AEC_DUMP` action and reads the resulting files from Discord's `discord_voice` module data directory.

In the inspected Discord 1.0.9267 voice module, enabling `setAecDump` sets a flag, and the dump writer starts when the voice stream is created. ReCord patches `_connectMediaEngineWithEndpoint` to prepare its file baseline and enable diagnostics before that stream is created. This allows buffering to start on a normal voice join. Setup has a two-second timeout; if it fails, the voice connection continues and ReCord reports the error. The patch and diagnostic format are internal Discord interfaces and may change with client updates.

## Audio pipeline

The native helper reads new `aecdump<N>` files incrementally. A decoder handles partial WebRTC protobuf records and converts supported input layouts and sample rates to stereo 48 kHz PCM. The decoded playout stream feeds a 30-second memory buffer and, while recording, a streaming WAV writer. Clip saves snapshot the buffer without stopping the recording.

Microphone inclusion is optional and uses processed microphone output. Discord's mute and deafen state gates that output in the saved mix. Temporary diagnostic files can still contain microphone input when microphone inclusion is disabled, so they should be treated as sensitive audio data.

ReCord ignores diagnostic files that existed before its capture session, removes files it observed being created, and retries cleanup when files are locked. It stops capture if its observed temporary files exceed 128 MiB. An existing Discord diagnostic capture must be stopped before ReCord starts.

## References

- [Vencord plugin setup](https://docs.vencord.dev/plugins/), [plugin API](https://docs.vencord.dev/plugins/common/), [native helpers](https://docs.vencord.dev/plugins/native/), and [patches](https://docs.vencord.dev/plugins/patches/).
- [Vencord custom plugin installation](https://docs.vencord.dev/installing/custom-plugins/) and [platform filtering](https://github.com/Vendicated/Vencord/blob/383409e6a6ec9008ee8a7496500f1e75f17824d1/scripts/build/common.mjs#L176).
- [VcRewind](https://github.com/fizzexual/VcRewind), a reference for diagnostic capture: [capture lifecycle](https://github.com/fizzexual/VcRewind/blob/a9b6aeaf1e21e730d6cba2e646a6398cd73968ae/index.tsx), [native helpers](https://github.com/fizzexual/VcRewind/blob/a9b6aeaf1e21e730d6cba2e646a6398cd73968ae/native.ts), [dump parser](https://github.com/fizzexual/VcRewind/blob/a9b6aeaf1e21e730d6cba2e646a6398cd73968ae/dump.ts), and [encoding](https://github.com/fizzexual/VcRewind/blob/a9b6aeaf1e21e730d6cba2e646a6398cd73968ae/ogg.ts).

The Vencord development checkout is pinned to `383409e6a6ec9008ee8a7496500f1e75f17824d1`. VcRewind is licensed under GPL-3.0-or-later.
