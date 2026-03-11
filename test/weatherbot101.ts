import * as weatherbor101 from "@/modules/bots/weatherbot101"
import '@/gracedown'

weatherbor101.weatherBotApp({
    botToken: process.env.WEATHERBOT101_TOKEN!,
    webhookUrl: "",
    localDebug: true,
})
