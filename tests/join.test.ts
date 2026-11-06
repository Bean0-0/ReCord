import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { CaptureSession } from "../plugin/capture";
import { prepareVoiceJoin, voiceJoinPatch } from "../plugin/connection";
import { type AudioPacket, type AudioSource } from "../plugin/loopback";
import { pcmFrames } from "./fixtures";

interface TestRtc {
    context: string;
    _socket: object;
    createStream: () => void;
    _connectMediaEngineWithEndpoint(endpoint: object, ready: { socket: object; }): Promise<void>;
}

function patchedRtc(bridge: { shouldPrepareCapture: (rtc: TestRtc) => boolean; beforeVoiceConnect: (rtc: TestRtc) => Promise<void>; }) {
    const source = "class TestRtc {_connectMediaEngineWithEndpoint(endpoint,ready){this.createStream()}}";
    const patched = source.replace(voiceJoinPatch.replacement.match, voiceJoinPatch.replacement.replace.replaceAll("$self", "bridge"));
    assert.notEqual(patched, source, "the patch must intercept the stream creation method");
    const Constructor = new Function("bridge", `${patched}; return TestRtc;`)(bridge) as new () => TestRtc;
    const rtc = new Constructor();
    rtc.context = "default";
    rtc._socket = {};
    return rtc;
}

test("join starts the in-memory source before the voice stream; recording reuses it", async t => {
    const root = await mkdtemp(join(tmpdir(), "record-join-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const now = Math.ceil(Date.now() / 10) * 10;
    let receive: ((packet: AudioPacket) => void) | undefined;
    let active = false;
    const source: AudioSource = {
        async start(onPacket) { receive = onPacket; active = true; },
        async stop() { active = false; }
    };
    const capture = new CaptureSession(source, join(root, "output"), false, false, now);
    let streamStarts = 0;
    const errors: unknown[] = [];
    const rtc = patchedRtc({
        shouldPrepareCapture: () => true,
        beforeVoiceConnect: () => prepareVoiceJoin(() => capture.prepare(), error => errors.push(error))
    });
    rtc.createStream = () => {
        streamStarts++;
        assert.equal(active, true);
        receive?.({ kind: "playout", time: now, pcm: pcmFrames(100, 1000) });
    };
    await rtc._connectMediaEngineWithEndpoint({}, { socket: rtc._socket });
    await capture.poll(now + 1000);
    assert.ok(capture.status.bufferedSeconds > 0);
    assert.equal(errors.length, 0);
    await capture.startRecording();
    receive?.({ kind: "playout", time: now + 1000, pcm: pcmFrames(100, 2000) });
    await capture.poll(now + 2000);
    assert.ok((await capture.saveClip()).seconds > 1);
    assert.equal((await capture.stopRecording()).seconds, 1);
    assert.equal(streamStarts, 1, "recording and clips must not recreate the voice stream");
    await capture.end();
});

test("a canceled join cannot create an old voice stream after capture preparation finishes", async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const rtc = patchedRtc({ shouldPrepareCapture: () => true, beforeVoiceConnect: () => pending });
    let streamStarts = 0;
    rtc.createStream = () => { streamStarts++; };
    const joining = rtc._connectMediaEngineWithEndpoint({}, { socket: rtc._socket });
    rtc._socket = {};
    release();
    await joining;
    assert.equal(streamStarts, 0);
});

test("capture setup failures still let the voice stream join", async () => {
    const errors: unknown[] = [];
    const rtc = patchedRtc({
        shouldPrepareCapture: () => true,
        beforeVoiceConnect: () => prepareVoiceJoin(async () => { throw new Error("native capture unavailable"); }, error => errors.push(error))
    });
    let joined = false;
    rtc.createStream = () => { joined = true; };
    await rtc._connectMediaEngineWithEndpoint({}, { socket: rtc._socket });
    assert.equal(joined, true);
    assert.match(String(errors[0]), /native capture unavailable/);
});

test("a slow capture setup times out without blocking voice or enabling late capture", async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    let lateCapture = false;
    const errors: unknown[] = [];
    const rtc = patchedRtc({
        shouldPrepareCapture: () => true,
        beforeVoiceConnect: () => prepareVoiceJoin(async signal => {
            await pending;
            if (!signal.aborted) lateCapture = true;
        }, error => errors.push(error), 10)
    });
    let joined = false;
    rtc.createStream = () => { joined = true; };
    await rtc._connectMediaEngineWithEndpoint({}, { socket: rtc._socket });
    assert.equal(joined, true);
    assert.match(String(errors[0]), /setup timed out/);
    release();
    await pending;
    assert.equal(lateCapture, false);
});

test("streams outside the capture hook still connect without preparing a buffer", async () => {
    let prepared = false;
    const rtc = patchedRtc({
        shouldPrepareCapture: () => false,
        beforeVoiceConnect: async () => { prepared = true; }
    });
    let joined = false;
    rtc.createStream = () => { joined = true; };
    await rtc._connectMediaEngineWithEndpoint({}, { socket: rtc._socket });
    assert.equal(joined, true);
    assert.equal(prepared, false);
});
