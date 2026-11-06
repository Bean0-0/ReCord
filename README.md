# ReCord

An experimental Vencord userplugin for **official Discord desktop on Windows**:

- Automatically buffer call audio when you join, then save the last 30 seconds on demand.
- Start and stop full recordings independently of the replay buffer.
- Save stereo 48 kHz WAV files locally in your system's Videos/ReCord folder.
- Optionally include the selected microphone while unmuted.

ReCord captures Discord audio into a 30-second RAM buffer. Clips and recordings are saved as WAV files when requested. The capture backend supports official Discord desktop on Windows; browser Discord and Vesktop are not supported.

## Build and install

Requires 64-bit Windows 10 build 20348 or later, Git, Node.js 22 or later, npm, and Visual Studio or Build Tools with the **Desktop development with C++** workload and Windows SDK. From this repository:

```sh
npm ci
npm test
npm run setup:vencord
npm run build
```

Setup prepares an ignored `.dev/vencord` source checkout at the inspected revision, installs its declared pnpm version through npm, and copies `plugin/` into `src/userplugins/reCord.discordDesktop`. Build compiles the Windows capture helper, checks and lints ReCord, and builds the Vencord development bundles. It does not change your Discord installation.

To install the resulting custom build, run the Vencord installer and select your Discord installation:

```sh
node .dev/vencord/scripts/runInstaller.mjs -- --install
```

Fully quit and restart Discord, then enable **ReCord** in Settings → Vencord → Plugins. Native changes need a full restart, not just Ctrl+R.

If you already maintain a Vencord source checkout, use `npm run install-plugin -- C:\path\to\Vencord` and `npm run build -- C:\path\to\Vencord` instead. Re-run the copy/build step after editing this plugin.

## Use

Open ReCord through the chat-bar recording icon, Vencord Toolbox → ReCord controls, `/record`, or the plugin's settings.

1. Enable ReCord before joining a voice call. Buffering starts automatically as Discord creates the voice stream; the chat-bar icon turns green. Open ReCord controls and confirm the buffered seconds increase. ReCord does not leave or rejoin the call. If you enable it during an existing call, buffering starts on your next normal join.
2. Use **Clip last 30 seconds**, `/clip`, or **Ctrl+Shift+S** while Discord is focused. Early clips contain only the available audio. Capture has a short processing delay.
3. Choose **Start recording** to record from that moment using the running capture session; the icon turns red and the controls show its duration. Starting recording does not restart the voice connection. **Stop and save recording** saves it while buffering continues. Clips also work during a recording.
4. **Stop capture** saves an active recording and pauses buffering for the current call. On your next normal join, buffering starts again. Leaving or changing voice connections ends the previous session and saves an active recording. A new voice stream gets a new buffer.
5. Use **Open recordings folder** to find the saved files. Files stay local; the plugin does not upload them.

The microphone setting applies when capture starts. It records the selected input device directly, so Discord's noise suppression and other voice processing are not applied. Mute and deafen state are applied to the saved mix. Let participants know before recording: the status icon only appears in your client.

## Limits

- The 30-second replay buffer and capture stream stay in memory. ReCord does not create temporary audio files. Windows may page process memory to disk according to its system settings. If Discord diagnostic recording is already active, ReCord pauses capture and offers a control to stop it because diagnostics can write audio to disk.
- Starting a full recording writes audio to a WAV file as it arrives. Saving a clip writes the buffered audio to a WAV file.
- Capture includes audio played by the Discord process and its children, which may include notification sounds and shared-stream audio. It does not capture audio from unrelated applications.
- The microphone input is captured separately from Discord's processed voice stream. If the selected microphone changes, capture stops and resumes on the next voice join.
- Process-specific loopback requires Windows 10 build 20348 or later. Discord or Windows updates may affect capture.
- WAV is uncompressed. Long recordings split into numbered parts at 256 MiB. Headers update during recording so completed audio is usually playable after an unexpected exit; power-loss durability is not guaranteed.
- The shortcut works while Discord is focused. Separate speaker tracks, global shortcuts, and compressed export are not supported.

See the [testing guide](docs/TESTING.md) and [capture internals](docs/RESEARCH.md). Licensed under [GPL-3.0-or-later](LICENSE).
