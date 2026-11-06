# ReCord

An experimental Vencord userplugin for **official Discord desktop on Windows**:

- Automatically buffer call audio when you join, then save the last 30 seconds on demand.
- Start and stop full recordings independently of the replay buffer.
- Save stereo 48 kHz WAV files locally in your system's Videos/ReCord folder.
- Optionally include processed microphone audio while unmuted.

The audio pipeline has automated tests and builds against Vencord. **The user has confirmed live capture works with automatic buffering on join.** ReCord prepares capture before Discord creates the voice stream, without forcing a reconnect. Additional device, mute-state, and long-session checks remain in the testing checklist. Browser Discord and Vesktop are not supported by this backend.

## Build and install

Requires Git, Node.js 22 or later, and npm. From this repository:

```sh
npm ci
npm test
npm run setup:vencord
npm run build
```

Setup prepares an ignored `.dev/vencord` source checkout at the inspected revision, installs its declared pnpm version through npm, and copies `plugin/` into `src/userplugins/reCord.discordDesktop`. Build runs Vencord's TypeScript check, lints ReCord, and builds the development bundles. It does not change your Discord installation.

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

The microphone setting applies when capture starts. Let participants know before recording. The status icon indicates local capture; it does not notify other participants.

## Prototype limits

- While ReCord is enabled, each normal voice join automatically starts capture. Its startup hook prepares the file baseline and enables diagnostics before stream creation. Capture setup is limited to two seconds; a failure lets the call join normally and reports an error.
- Capture uses Discord's internal WebRTC diagnostic dump format. Client updates may break it. If no readable audio arrives for 10 seconds, ReCord stops and reports an error.
- ReCord checks that its recording code and interface have the same revision. After rebuilding, fully quit Discord from its system tray icon and reopen it; Ctrl+R leaves the previous native code running. A mismatch prevents capture and shows restart instructions.
- Recordings stay armed until audio arrives; an empty capture does not save a zero-second WAV. Timeout errors in ReCord controls include the directory scanned and file/frame counts, without Electron's remote-call wrapper.
- Diagnostic files can contain microphone input even if microphone inclusion is off. ReCord only exports processed microphone output and applies Discord's mute/deafen state to it; that behavior still needs a live test.
- The 30-second replay buffer lives in memory. Discord also writes temporary diagnostic files to disk. ReCord removes consumed files it observed being created, retries locked-file cleanup, and stops capture if observed temporary data exceeds 128 MiB. Pre-existing files are preserved and ignored. Discord's diagnostic capture must be off before starting ReCord; avoid running another AEC-dump plugin alongside it.
- WAV is uncompressed. Long recordings split into numbered parts at 256 MiB. Headers update during recording so completed audio is usually playable after an unexpected exit; power-loss durability is not guaranteed. Hard crashes can leave diagnostic files or state behind.
- Audio is the mixed playout stream, with optional local mic, rather than separate speaker tracks. Soundboards and screenshare audio need verification. The shortcut works while Discord is focused; global shortcuts and compressed export are future work.

See [the live-test checklist](docs/TESTING.md) and [implementation research](docs/RESEARCH.md). Licensed under [GPL-3.0-or-later](LICENSE).
