/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 ReCord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Bump when renderer/native changes require a full process restart.
export const CAPTURE_REVISION = "2026-11-06.4";

export async function checkNativeVersion(native: { getCaptureRevision?: () => Promise<string>; }) {
    if (typeof native.getCaptureRevision !== "function" || await native.getCaptureRevision() !== CAPTURE_REVISION)
        throw new Error("ReCord was updated. Fully quit Discord from the system tray and reopen it to load recording fixes.");
}
