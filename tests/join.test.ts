import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { CaptureSession } from "../plugin/capture";
import { voiceJoinPatch } from "../plugin/connection";
import { frames, init } from "./fixtures";

interface TestRtc {
    createStream: () => void;
    _connectMediaEngineWithEndpoint(endpoint: object, ready: object): unknown;
}

function patchedRtc(beforeVoiceConnect: (rtc: TestRtc) => unknown) {
    const source = "class TestRtc {_connectMediaEngineWithEndpoint(endpoint,ready){this.createStream()}}";
    const patched = source.replace(voiceJoinPatch.replacement.match, voiceJoinPatch.replacement.replace.replaceAll("$self", "bridge"));
    assert.notEqual(patched, source, "the patch must intercept the stream creation method");
    const Constructor = new Function("bridge", `${patched}; return TestRtc;`)({ beforeVoiceConnect }) as new () => TestRtc;
    return new Constructor();
}

test("the join hook runs and the voice stream is created in the same tick", () => {
    // Delaying stream creation drops voice gateway messages and DAVE disconnects the call (4803).
    const order: string[] = [];
    const rtc = patchedRtc(() => { order.push("hook"); return new Promise(() => { }); });
    rtc.createStream = () => { order.push("stream"); };
    const result = rtc._connectMediaEngineWithEndpoint({}, {});
    assert.deepEqual(order, ["hook", "stream"]);
    assert.equal(result, undefined, "the patched method must stay synchronous");
});

test("native setup after stream creation still reads the new stream's dump", async t => {
    const root = await mkdtemp(join(tmpdir(), "record-join-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const dumps = join(root, "dumps");
    await mkdir(dumps);
    const now = Math.floor(Date.now() / 10) * 10;
    let dumpEnabled = false;
    const rtc = patchedRtc(() => { dumpEnabled = true; });
    rtc.createStream = () => {
        assert.equal(dumpEnabled, true, "the flag must be on before stream creation");
        writeFileSync(join(dumps, "aecdump0"), Buffer.concat([init(now), frames(100, 1000)]));
    };
    rtc._connectMediaEngineWithEndpoint({}, {});
    const capture = new CaptureSession(dumps, join(root, "output"), false, false, now);
    await capture.prepare();
    assert.equal(capture.status.diagnostics.baselineFiles, 0, "a dump born after the join is not pre-existing");
    await capture.poll();
    assert.ok(capture.status.bufferedSeconds > 0);
    await capture.startRecording();
    await appendFile(join(dumps, "aecdump0"), frames(100, 2000));
    await capture.poll();
    assert.ok((await capture.saveClip()).seconds > 1);
    assert.equal((await capture.stopRecording()).seconds, 1);
    await capture.end();
});
