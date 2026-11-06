/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 ReCord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { isAbsolute, join } from "node:path";

export function voiceDumpDirectory(userData: string, discordPaths: { moduleDataPath?: unknown; modulePath?: unknown; }) {
    // This is the same main-process value exposed by Discord's getModuleDataPathSync().
    const root = discordPaths.moduleDataPath ?? discordPaths.modulePath;
    if (typeof root === "string" && isAbsolute(root)) return join(root, "discord_voice");
    return join(userData, "module_data", "discord_voice");
}
