import assert from "node:assert/strict";
import { test } from "node:test";

import { CaptureConnection } from "../plugin/connection";

test("capture survives its initial voice join and stops on a later loss", () => {
    const capture = new CaptureConnection("call");
    for (const state of ["DISCONNECTED", "CONNECTING", "AUTHENTICATING", "RTC_CONNECTING"])
        assert.equal(capture.accepts("call", state), true);
    assert.equal(capture.connecting, true);
    assert.equal(capture.accepts("call", "RTC_CONNECTED"), true);
    assert.equal(capture.connecting, false);
    assert.equal(capture.accepts("call", "RTC_DISCONNECTED"), false);
});

test("leaving or moving channels stops capture even during the initial join", () => {
    const capture = new CaptureConnection("call");
    assert.equal(capture.accepts(undefined, "DISCONNECTED"), false);
    assert.equal(capture.accepts("other-call", "RTC_CONNECTING"), false);
    assert.equal(capture.accepts("other-call", "RTC_CONNECTED"), false);
});
