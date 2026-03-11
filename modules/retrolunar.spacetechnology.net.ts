import {Elysia} from "elysia"

import * as usernametoidbot from "./bots/usernametoidbot"

const hostname = "retolunar.spacetechnology.net"

export const app = new Elysia()
    .get("/", `HELLO FROM ${hostname}!`)
    .mount("/halo", usernametoidbot.app({ 
        webhookUrl: `https://${hostname}/halo`
    }).fetch)
