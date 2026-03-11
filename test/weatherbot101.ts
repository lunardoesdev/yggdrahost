import * as weatherbor101 from "@/modules/bots/weatherbot101"

// graceful shutdown
const shutdown = async (signal: string) => {
    console.log(`\n🛑 Received ${signal}. Shutting down gracefully...`)
    console.log("Resetting webhook")
    await weatherbor101.setWebhookBack()
    console.log("Successfully reset webhook")
    process.exit(0)
}

process.on("SIGINT", () => shutdown("SIGINT"))   // Ctrl+C
process.on("SIGTERM", () => shutdown("SIGTERM")) // Docker, process managers, etc.

weatherbor101.weatherBotApp({
    botToken: process.env.WEATHERBOT101_TOKEN!,
    webhookUrl: "https://retrolunar.spacetechnology.net/weatherbot101",
    localDebug: true,
    secretToken: process.env.WEATHERBOT101_SECRET,
})
