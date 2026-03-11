import { Elysia } from "elysia"
import { Bot, webhookCallback, Context } from "grammy"

// ====================== CONFIG & CACHE SETTINGS ======================
type Config = {
  webhookUrl: string,
  botToken: string,
  secretToken?: string,
  localDebug?: boolean,
}

// Cache TTL (Time To Live)
const LOCATION_CACHE_TTL = 12 * 60 * 60 * 1000   // 12 hours - cities don't change often
const WEATHER_CACHE_TTL = 20 * 60 * 1000         // 20 minutes - weather changes frequently
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000       // Run cleanup every 10 minutes

// In-memory caches with metadata
const locationCache = new Map<string, { data: any; timestamp: number }>()
const weatherCache = new Map<string, { data: any; timestamp: number }>()

// ====================== CACHE HELPERS ======================

/**
 * Check if cached item has expired
 */
function isExpired(timestamp: number, ttl: number): boolean {
  return Date.now() - timestamp > ttl
}

/**
 * Remove expired items from cache
 */
function cleanupCache(cache: Map<string, { data: any; timestamp: number }>, ttl: number) {
  const now = Date.now()
  let deleted = 0

  for (const [key, entry] of cache.entries()) {
    if (isExpired(entry.timestamp, ttl)) {
      cache.delete(key)
      deleted++
    }
  }

  if (deleted > 0) {
    console.log(`🧹 Cleaned up ${deleted} expired cache entries`)
  }
}

/**
 * Search for locations using Open-Meteo Geocoding API
 */
async function searchLocation(query: string) {
  const cacheKey = query.toLowerCase().trim()

  const cached = locationCache.get(cacheKey)
  if (cached && !isExpired(cached.timestamp, LOCATION_CACHE_TTL)) {
    return cached.data
  }

  const url = new URL("https://geocoding-api.open-meteo.com/v1/search")
  url.searchParams.set("name", query)
  url.searchParams.set("count", "6")
  url.searchParams.set("language", "ru")
  url.searchParams.set("format", "json")

  const res = await fetch(url)
  const data = await res.json()

  const results = (data as any).results || []
  
  locationCache.set(cacheKey, { data: results, timestamp: Date.now() })
  return results
}

/**
 * Get current weather using Open-Meteo Forecast API
 */
async function getWeather(latitude: number, longitude: number) {
  const cacheKey = `${latitude.toFixed(4)},${longitude.toFixed(4)}`

  const cached = weatherCache.get(cacheKey)
  if (cached && !isExpired(cached.timestamp, WEATHER_CACHE_TTL)) {
    return cached.data
  }

  const url = new URL("https://api.open-meteo.com/v1/forecast")
  url.searchParams.set("latitude", latitude.toString())
  url.searchParams.set("longitude", longitude.toString())
  url.searchParams.set("current", "temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m")
  url.searchParams.set("timezone", "auto")

  const res = await fetch(url)
  const data = await res.json()

  weatherCache.set(cacheKey, { data, timestamp: Date.now() })
  return data
}

// ====================== WEATHER FORMATTING ======================
function getWeatherEmoji(code: number): string {
  if (code === 0) return "☀️"
  if ([1, 2, 3].includes(code)) return "⛅"
  if ([45, 48].includes(code)) return "🌫️"
  if (code >= 51 && code <= 67) return "🌧️"
  if (code >= 71 && code <= 77) return "❄️"
  if (code >= 80 && code <= 82) return "🌦️"
  if (code >= 95) return "⛈️"
  return "🌡️"
}

function formatWeather(location: any, weather: any): string {
  const current = weather.current
  const emoji = getWeatherEmoji(current.weather_code)

  return `${emoji} <b>${location.name}, ${location.country || location.admin1 || ""}</b>\n\n` +
    `🌡️ Temperature: <b>${current.temperature_2m}°C</b>\n` +
    `🤔 Feels like: ${current.apparent_temperature}°C\n` +
    `💧 Humidity: ${current.relative_humidity_2m}%\n` +
    `🌬️ Wind: ${current.wind_speed_10m} km/h\n\n` +
    `<i>Updated: ${new Date(current.time).toLocaleString("en-US")}</i>`
}

// ====================== MAIN BOT ======================
export async function weatherBotApp(config: Config) {
  const bot = new Bot(config.botToken)

  // Start periodic cache cleanup
  const cleanupTimer = setInterval(() => {
    cleanupCache(locationCache, LOCATION_CACHE_TTL)
    cleanupCache(weatherCache, WEATHER_CACHE_TTL)
  }, CLEANUP_INTERVAL_MS)

  // Graceful shutdown
  process.on("SIGTERM", () => clearInterval(cleanupTimer))
  process.on("SIGINT", () => clearInterval(cleanupTimer))

  // Commands
  bot.command("start", (ctx) =>
    ctx.reply(
      "☀️ <b>Weather Bot</b>\n\n" +
      "Just send me any city, region or country name.\n" +
      "Examples: <code>london</code>, <code>new york</code>, <code>tokyo</code>",
      { parse_mode: "HTML" }
    )
  )

  // Main handler
  bot.on("message:text", async (ctx: Context) => {
    const text = ctx.message?.text?.trim() || "undefined"
    if (text.search("погода") == -1) return

    await ctx.replyWithChatAction("typing")

    const words = text.split(" ")
    const locations = await searchLocation(words[words.length - 1] || "undefined")

    if (locations.length === 0) {
      return ctx.reply("❌ Sorry, I couldn't find that location. Please try again.")
    }

    const loc = locations[0]
    const weatherData = await getWeather(loc.latitude, loc.longitude)
    const message = formatWeather(loc, weatherData)
    return ctx.reply(message, { parse_mode: "HTML" })

  })

  // Callback handler
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data
    if (!data.startsWith("weather:")) return

    const [, lat, lon, name] = data.split(":")
    await ctx.answerCallbackQuery()

    const weatherData = await getWeather(parseFloat(lat!), parseFloat(lon!))
    const message = formatWeather({ name, country: "" }, weatherData)

    await ctx.editMessageText(message, { parse_mode: "HTML" })
  })

  // ====================== ELYSIA ======================
  const app = new Elysia()
    if (!config.localDebug) {
        app
        .get("/aboutbot", () => `Weather Bot running on ${config.webhookUrl}`)

        .post("/", webhookCallback(bot, "elysia", {
        secretToken: config.secretToken,
        }))

        //console.log(config.webhookUrl)
    
        await bot.api.setWebhook(config.webhookUrl, {
            secret_token: config.secretToken,
            allowed_updates: ["message", "callback_query"],
        })
    } else {
        bot.start()
    }

  return app
}