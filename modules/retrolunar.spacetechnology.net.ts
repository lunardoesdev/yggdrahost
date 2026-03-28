import {Elysia} from "elysia"

import * as usernametoidbot from "./bots/usernametoidbot"
import * as weatherbot101 from "./bots/weatherbot101"
import * as supportbot from "./bots/supportbot"
import * as plisiobot from "./bots/plisiosupportbot"

const hostname = "retrolunar.spacetechnology.net"

export const app = new Elysia()
    .get("/", `HELLO FROM ${hostname}!`)
    .mount("/halo", usernametoidbot.app({ 
        webhookUrl: `https://${hostname}/halo`
    }).fetch)
    .mount("/supportbot", (await supportbot.newSupportBot({
        botToken: process.env.SUPPORTBOT_TOKEN || "invalid",
        secretToken: process.env.SUPPORTBOT_SECRET || "invalid",
        webhookUrl: `https://${hostname}/supportbot`
    })).fetch)
    .mount("/plisiobot", (await plisiobot.app({
        botToken: process.env.PLISIOBOT_TOKEN || "invalid",
        secretToken: process.env.PLISIOBOT_SECRET || "invalid",
        webhookUrl: `https://${hostname}/plisiobot`,
    })).fetch)
    .mount("/weatherbot101", (await weatherbot101.weatherBotApp({
        webhookUrl: `https://${hostname}/weatherbot101`,
        secretToken: process.env.WEATHERBOT101_SECRET,
        botToken: process.env.WEATHERBOT101_TOKEN || "invalid",
    })).fetch)
