import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { CaptureSession } from "../plugin/capture";
import { LoopbackSource } from "../plugin/loopback";

if (process.platform !== "win32") throw new Error("This test requires Windows");

function encoded(script: string) {
    return Buffer.from(script, "utf16le").toString("base64");
}

function toneScript(amplitude: number) {
    return `
Add-Type -AssemblyName System
$sampleRate = 16000
$sampleCount = 32000
$stream = New-Object System.IO.MemoryStream
$writer = New-Object System.IO.BinaryWriter($stream)
$writer.Write([System.Text.Encoding]::ASCII.GetBytes('RIFF'))
$writer.Write([int](36 + $sampleCount * 2))
$writer.Write([System.Text.Encoding]::ASCII.GetBytes('WAVEfmt '))
$writer.Write([int]16)
$writer.Write([int16]1)
$writer.Write([int16]1)
$writer.Write([int]$sampleRate)
$writer.Write([int]($sampleRate * 2))
$writer.Write([int16]2)
$writer.Write([int16]16)
$writer.Write([System.Text.Encoding]::ASCII.GetBytes('data'))
$writer.Write([int]($sampleCount * 2))
for ($i = 0; $i -lt $sampleCount; $i++) { $writer.Write([int16](${amplitude} * [Math]::Sin(2 * [Math]::PI * 440 * $i / $sampleRate))) }
$writer.Flush()
$stream.Position = 0
$player = New-Object System.Media.SoundPlayer($stream)
[Console]::WriteLine('READY')
[Console]::ReadLine() | Out-Null
$player.PlaySync()
`;
}

function playerScript(amplitude: number, useChild: boolean) {
    const tone = encoded(toneScript(amplitude));
    if (!useChild) return toneScript(amplitude);
    // Capture the parent PID while its child produces the tone.
    return `
$info = New-Object System.Diagnostics.ProcessStartInfo
$info.FileName = 'powershell.exe'
$info.Arguments = '-NoProfile -EncodedCommand ${tone}'
$info.UseShellExecute = $false
$info.CreateNoWindow = $true
$info.RedirectStandardInput = $true
$info.RedirectStandardOutput = $true
$info.RedirectStandardError = $true
$child = [System.Diagnostics.Process]::Start($info)
if ($child.StandardOutput.ReadLine() -ne 'READY') { throw 'Tone child did not initialize' }
[Console]::WriteLine('READY')
[Console]::ReadLine() | Out-Null
$child.StandardInput.WriteLine('play')
$child.StandardInput.Flush()
$child.WaitForExit()
if ($child.ExitCode -ne 0) { throw $child.StandardError.ReadToEnd() }
`;
}

async function startPlayer(amplitude: number, useChild: boolean) {
    const player = spawn("powershell.exe", ["-NoProfile", "-EncodedCommand", encoded(playerScript(amplitude, useChild))], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let errors = "";
    player.stderr.on("data", chunk => { errors = (errors + chunk.toString()).slice(-3000); });
    await new Promise<void>((ready, reject) => {
        const timeout = setTimeout(() => reject(new Error("Tone generator timed out")), 10000);
        player.once("error", reject);
        player.stdout.on("data", chunk => { if (chunk.toString().includes("READY")) { clearTimeout(timeout); ready(); } });
        player.once("exit", code => { if (code !== 0) reject(new Error(`Tone generator exited ${code}: ${errors}`)); });
    });
    return player;
}

const target = await startPlayer(100, true);
const other = await startPlayer(300, false);
const output = await mkdtemp(join(tmpdir(), "record-loopback-test-"));
const executable = resolve(process.argv[2] ?? ".dev/vencord/dist/ReCordCapture.exe");
const source = new LoopbackSource(executable, target.pid!);
const capture = new CaptureSession(source, output, false, false);
let ended = false;
try {
    const missingMic = new LoopbackSource(executable, target.pid!, "{ffffffff-ffff-ffff-ffff-ffffffffffff}");
    try { await assert.rejects(missingMic.start(() => { }, () => { }), /Microphone capture failed/); }
    finally { await missingMic.stop(); }
    await capture.prepare();
    target.stdin.end("\n");
    other.stdin.end("\n");
    const start = Date.now();
    while (Date.now() - start < 3400) {
        await sleep(100);
        await capture.poll();
    }
    assert.ok(capture.status.bufferedSeconds > 1, "the RAM buffer did not advance");
    assert.equal(capture.status.receivingAudio, true, "no process-loopback packets were received");
    assert.deepEqual(await readdir(output), [], "buffering wrote an audio file");
    const clip = await capture.saveClip();
    const wav = await readFile(clip.path);
    let peak = 0;
    for (let i = 44; i + 1 < wav.length; i += 2) peak = Math.max(peak, Math.abs(wav.readInt16LE(i)));
    assert.ok(peak > 20, `target process-tree tone missing from clip (peak ${peak})`);
    assert.ok(peak < 200, `audio from a separate process leaked into the clip (peak ${peak})`);
    await capture.end();
    ended = true;
    console.log(`Process loopback passed: ${clip.seconds.toFixed(2)} seconds, target tone peak ${peak}; no audio files before saving.`);
} finally {
    if (!ended) await capture.end().catch(() => { });
    if (target.exitCode === null) target.kill();
    if (other.exitCode === null) other.kill();
    for (const name of await readdir(output)) await unlink(join(output, name));
    await rmdir(output);
}
