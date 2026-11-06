import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import { CAPTURE_REVISION, checkNativeVersion } from "../plugin/compatibility";
import { errorMessage } from "../plugin/errors";
import { voiceDumpDirectory } from "../plugin/paths";

test("native errors show the original cause instead of an Electron IPC wrapper", () => {
    const reason = "No call audio received.\nDump files: 0";
    assert.equal(errorMessage(new Error(`Error invoking remote method 'VencordPluginNative_ReCord_poll': Error: ${reason}`)), reason);
    assert.equal(errorMessage(new Error(`Error invoking remote method 'outer': Error: Error invoking remote method 'inner': Error: ${reason}`)), reason);
    assert.match(errorMessage(new Error("Error invoking remote method 'test': Error: No handler registered for 'test'")), /Fully quit Discord/);
});

test("dump lookup uses Discord's module directory and keeps the legacy fallback", () => {
    const userData = join(process.cwd(), "discord-data");
    const modules = join(process.cwd(), "discord-modules");
    assert.equal(voiceDumpDirectory(userData, { moduleDataPath: modules }), join(modules, "discord_voice"));
    assert.equal(voiceDumpDirectory(userData, { modulePath: modules }), join(modules, "discord_voice"));
    assert.equal(voiceDumpDirectory(userData, {}), join(userData, "module_data", "discord_voice"));
    assert.equal(voiceDumpDirectory(userData, { moduleDataPath: "relative" }), join(userData, "module_data", "discord_voice"));
});

test("a renderer reload requires a restart when the native capture code is stale", async () => {
    await checkNativeVersion({ getCaptureRevision: async () => CAPTURE_REVISION });
    await assert.rejects(checkNativeVersion({}), /Fully quit Discord from the system tray/);
    await assert.rejects(checkNativeVersion({ getCaptureRevision: async () => "old" }), /Fully quit Discord from the system tray/);
});
