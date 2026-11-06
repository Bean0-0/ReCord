# Capture internals

ReCord is a Vencord userplugin for official Discord desktop on Windows. The renderer follows Discord's voice and mute state, and native helpers manage capture and recording. Vencord bundles the plugin from `src/userplugins/reCord.discordDesktop/`.

## Audio capture

A small Windows helper uses WASAPI process loopback to capture output from the Discord main process and its child processes. The optional microphone input uses a separate WASAPI capture client for the selected input device. Both streams are sent as timestamped 48 kHz stereo PCM packets over a pipe to the Vencord main process. ReCord does not enable diagnostic dumps or create temporary audio files. If Discord diagnostic recording is already active, ReCord stops or prevents its own capture and offers a control to turn diagnostics off.

When microphone inclusion is enabled, ReCord captures the selected input directly. It does not receive Discord's processed microphone stream. Discord's mute and deafen state is used to gate microphone samples in the saved mix; a microphone device change stops capture so the old device is not recorded accidentally.

ReCord prepares capture before Discord creates the voice stream. A two-second setup timeout lets the voice connection continue if capture fails. Capture also stops when the voice connection changes or the plugin is disabled. Process loopback requires Windows 10 build 20348 or later.

## Buffer and recordings

Incoming packets are aligned and mixed into stereo 48 kHz PCM. A bounded ring keeps the latest 30 seconds in memory; saving a clip snapshots it to WAV. Full recordings use the same stream and write WAV segments while recording is active. The packet queue is bounded so a stalled consumer cannot grow without limit.

ReCord does not write buffered audio to disk until a clip is saved or a full recording is started. Windows may page process memory to disk according to its system settings.

## References

- [Windows application loopback capture](https://learn.microsoft.com/windows/win32/coreaudio/application-loopback-api-capture-sample).
- [Vencord plugin setup](https://docs.vencord.dev/plugins/), [plugin API](https://docs.vencord.dev/plugins/common/), [native helpers](https://docs.vencord.dev/plugins/native/), and [patches](https://docs.vencord.dev/plugins/patches/).
- [Vencord custom plugin installation](https://docs.vencord.dev/installing/custom-plugins/) and [platform filtering](https://github.com/Vendicated/Vencord/blob/383409e6a6ec9008ee8a7496500f1e75f17824d1/scripts/build/common.mjs#L176).

The Vencord development checkout is pinned to `383409e6a6ec9008ee8a7496500f1e75f17824d1`.
