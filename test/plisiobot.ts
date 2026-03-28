import { app } from "../modules/bots/plisiosupportbot"

const bot = await app({
    botToken: process.env.PLISIOBOT_TOKEN || "",
    secretToken: "debug",
    webhookUrl: "http://localhost:3333/plisiobot",
    localDebug: true,
})

bot.listen(3333, () => {
    console.log("plisiobot debug server on http://localhost:3333")
})
