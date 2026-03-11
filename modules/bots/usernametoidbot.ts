import {Elysia} from "elysia"

export function app(config: {
    webhookUrl: string
}) {
    const app = new Elysia()
        .get("/aboutbot", "Hello from usernametoidbot from " + `${config.webhookUrl}`)
        .get("/", "Hello from main bot part from " + `${config.webhookUrl}`)
    
    return app
}