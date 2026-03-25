import { Elysia } from "elysia"
import { Bot, webhookCallback, Context } from "grammy"

type Config = {
    webhookUrl: string,
    botToken: string,
    secretToken: string,
    localDebug?: boolean,
}

export async function newSupportBot(config: Config) {
    const debug = config.localDebug || false
    const token = config.botToken
    const secretToken = config.secretToken
    const webhookUrl = config.webhookUrl

    const bot = new Bot(token)

    bot.on("message", async (ctx: Context) => {
        await ctx.reply(`I am alive, your message was: ${ctx.message?.text || 'no text'}`)
    })

    const app = new Elysia()

    if (debug) {
        bot.start()
    } else {
        app
            .get("/aboutbot", () => `SupportBot running on ${webhookUrl}`)
            .post("/", webhookCallback(bot, "elysia", {
                secretToken: secretToken
            }))
        await bot.api.setWebhook(config.webhookUrl, {
            secret_token: secretToken,
        })
    }

    return app
}