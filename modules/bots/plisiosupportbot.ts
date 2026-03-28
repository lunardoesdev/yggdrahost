import Elysia from "elysia"
import { Bot, webhookCallback, Context } from "grammy"

export async function app(cfg: {
    debug: boolean,
    botToken: string,
    webhookUrl: string,
    secretToken: string
}) {
    const app = new Elysia()
    const bot = new Bot(cfg.botToken)

    if (!cfg.debug) {
        // add url handling
    } else {
        bot.start()
    }

    return app
}