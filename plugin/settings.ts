/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 ReCord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";

export const settings = definePluginSettings({
    includeMic: {
        type: OptionType.BOOLEAN,
        description: "Include your selected microphone while unmuted. Discord's voice processing is not applied. Applies on the next voice join.",
        default: false
    }
});
