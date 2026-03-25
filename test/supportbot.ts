import * as supportbot from "@/modules/bots/supportbot"

import '@/gracedown'

supportbot.newSupportBot({
    botToken: process.env.SUPPORTBOT_TOKEN!,
    webhookUrl: "https://retrolunar.spacetechnology.net/supportbot",
    localDebug: true,
    secretToken: process.env.SUPPORTBOT_SECRET || 'invalid',
})
