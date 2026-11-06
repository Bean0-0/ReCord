import assert from "node:assert/strict";
import { test } from "node:test";

import { CAPTURE_REVISION, checkNativeVersion } from "../plugin/compatibility";
import { errorMessage } from "../plugin/errors";

test("native errors show the original cause instead of an Electron IPC wrapper", () => {
    const reason = "Audio capture failed.\nCheck the input device.";
    assert.equal(errorMessage(new Error(`Error invoking remote method 'VencordPluginNative_ReCord_poll': Error: ${reason}`)), reason);
    assert.equal(errorMessage(new Error(`Error invoking remote method 'outer': Error: Error invoking remote method 'inner': Error: ${reason}`)), reason);
    assert.match(errorMessage(new Error("Error invoking remote method 'test': Error: No handler registered for 'test'")), /Fully quit Discord/);
});

test("a renderer reload requires a restart when the native capture code is stale", async () => {
    await checkNativeVersion({ getCaptureRevision: async () => CAPTURE_REVISION });
    await assert.rejects(checkNativeVersion({}), /Fully quit Discord from the system tray/);
    await assert.rejects(checkNativeVersion({ getCaptureRevision: async () => "old" }), /Fully quit Discord from the system tray/);
});
