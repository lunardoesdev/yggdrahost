import {Elysia} from "elysia"

import * as usernametoidbot from "./bots/usernametoidbot"
import * as weatherbot101 from "./bots/weatherbot101"

const hostname = "retrolunar.spacetechnology.net"

export const app = new Elysia()
    .get("/", `HELLO FROM ${hostname}!`)
    .mount("/halo", usernametoidbot.app({ 
        webhookUrl: `https://${hostname}/halo`
    }).fetch)
    .mount("/weatherbot101", (await weatherbot101.weatherBotApp({
        webhookUrl: `https://${hostname}/weatherbot101`,
        secretToken: process.env.WEATHERBOT101_SECRET
    })).fetch)
