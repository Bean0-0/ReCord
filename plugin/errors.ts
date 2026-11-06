/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 ReCord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export function errorMessage(error: unknown) {
    let message = error instanceof Error ? error.message : String(error);
    // Electron can wrap errors again when a failing capture is closed.
    for (;;) {
        const stripped = message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, "");
        if (stripped === message) break;
        message = stripped;
    }
    if (/No handler registered/.test(message))
        return "ReCord's native code is not loaded. Fully quit Discord from the system tray and reopen it after rebuilding.";
    return message;
}
