import {Elysia} from "elysia"
import usernametoidbot from "./bots/usernametoidbot"

function setup(app: Elysia, prefix: string): Elysia {
    usernametoidbot.setup(app, `${prefix}/usernametoidbot`)
    app.get(`${prefix}/`, "Hello from retrolunar.spacetechnology.net")
    return app
}

export default {
    setup: setup
}