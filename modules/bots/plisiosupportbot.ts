import { createHmac, timingSafeEqual } from "node:crypto"

import { Elysia } from "elysia"
import { Bot, Context, InlineKeyboard, webhookCallback } from "grammy"

type Config = {
    botToken: string
    webhookUrl: string
    secretToken: string
    localDebug?: boolean
    plisioApiKey?: string
    plisioSecretKey?: string
    baseCurrency?: string
    donationPresets?: number[]
}

type PlisioInvoiceResponse = {
    status: string
    data?: {
        txn_id?: string
        invoice_url?: string
        amount?: string
        pending_amount?: string
        wallet_hash?: string
        psys_cid?: string
        currency?: string
        source_currency?: string
        source_rate?: string
        expire_utc?: string
        expected_confirmations?: string
        qr_code?: string
        verify_hash?: string
        invoice_commission?: string
        invoice_sum?: string
        invoice_total_sum?: string
    }
    message?: string
}

type PlisioCallback = {
    txn_id?: string
    order_number?: string
    order_name?: string
    source_currency?: string
    source_amount?: string
    amount?: string
    pending_amount?: string
    wallet_hash?: string
    psys_cid?: string
    currency?: string
    status?: string
    comment?: string
    verify_hash?: string
    confirm_code?: string
    [key: string]: string | undefined
}

type DonationRecord = {
    chatId: number
    userId: number
    displayName: string
    orderId: string
    txnId?: string
    invoiceUrl?: string
    amount: number
    sourceCurrency: string
    cryptoCurrency?: string
    cryptoAmount?: string
    walletHash?: string
    status: string
    createdAt: number
    updatedAt: number
    thanked: boolean
}

const MAX_RECORDS = 2000
const RECORD_TTL_MS = 24 * 60 * 60 * 1000 // 24h
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000 // 10min
const DEFAULT_CURRENCY = "usd"
const DEFAULT_PRESETS = [5, 10, 25]
const PLISIO_API = "https://plisio.net/api/v1"
const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX = 30

// --- Bounded in-memory storage ---

const donations = new Map<string, DonationRecord>()
const txnToOrder = new Map<string, string>()
const userLatestOrder = new Map<number, string>()

function pruneOldRecords() {
    const now = Date.now()
    for (const [key, record] of donations) {
        if (now - record.updatedAt > RECORD_TTL_MS) {
            donations.delete(key)
            if (record.txnId) txnToOrder.delete(record.txnId)
            userLatestOrder.delete(record.userId)
        }
    }
}

function enforceMaxRecords() {
    if (donations.size <= MAX_RECORDS) return
    // evict oldest by updatedAt
    let oldest: { key: string; time: number } | undefined
    for (const [key, record] of donations) {
        if (!oldest || record.updatedAt < oldest.time) {
            oldest = { key, time: record.updatedAt }
        }
    }
    if (oldest) {
        const record = donations.get(oldest.key)
        if (record) {
            donations.delete(oldest.key)
            if (record.txnId) txnToOrder.delete(record.txnId)
        }
    }
}

// --- Rate limiter (per-IP, sliding window) ---

const rateLimitBuckets = new Map<string, number[]>()

function isRateLimited(ip: string): boolean {
    const now = Date.now()
    let timestamps = rateLimitBuckets.get(ip)
    if (!timestamps) {
        timestamps = []
        rateLimitBuckets.set(ip, timestamps)
    }
    // remove expired entries
    while (timestamps.length > 0 && now - timestamps[0]! > RATE_LIMIT_WINDOW_MS) {
        timestamps.shift()
    }
    if (timestamps.length >= RATE_LIMIT_MAX) return true
    timestamps.push(now)
    return false
}

function pruneRateLimiter() {
    const now = Date.now()
    for (const [ip, timestamps] of rateLimitBuckets) {
        while (timestamps.length > 0 && now - timestamps[0]! > RATE_LIMIT_WINDOW_MS) {
            timestamps.shift()
        }
        if (timestamps.length === 0) rateLimitBuckets.delete(ip)
    }
}

// --- Plisio callback signature verification ---

function verifyPlisioSignature(data: PlisioCallback, secretKey: string): boolean {
    const receivedHash = data.verify_hash
    if (!receivedHash || !secretKey) return false

    // Build sorted key=value pairs excluding verify_hash
    const filtered: Record<string, string> = {}
    for (const [key, value] of Object.entries(data)) {
        if (key !== "verify_hash" && value !== undefined) {
            filtered[key] = value
        }
    }

    const sortedKeys = Object.keys(filtered).sort()
    const message = JSON.stringify(
        sortedKeys.reduce<Record<string, string>>((obj, key) => {
            obj[key] = filtered[key]!
            return obj
        }, {}),
    )

    const expected = createHmac("sha1", secretKey).update(message).digest("hex")
    const expectedBuf = Buffer.from(expected, "utf8")
    const receivedBuf = Buffer.from(receivedHash, "utf8")

    if (expectedBuf.length !== receivedBuf.length) return false
    return timingSafeEqual(expectedBuf, receivedBuf)
}

// --- Helpers ---

function escapeHtml(s: string): string {
    return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;")
}

function describeUser(ctx: Context): string {
    const first = ctx.from?.first_name?.trim()
    const last = ctx.from?.last_name?.trim()
    const username = ctx.from?.username?.trim()
    const name = [first, last].filter(Boolean).join(" ")
    if (name) return username ? `${name} (@${username})` : name
    if (username) return `@${username}`
    return `user-${ctx.from?.id ?? "?"}`
}

function formatAmount(value: number | string | undefined, currency?: string): string {
    if (value === undefined || value === "") return "—"
    return `${value} ${currency?.toUpperCase() ?? ""}`.trim()
}

function normalizeAmount(s: string | undefined): number {
    if (!s) return NaN
    return Number.parseFloat(s.replace(",", "."))
}

function normalizeTicker(s: string | undefined, fallback = ""): string {
    const v = s?.trim().toLowerCase()
    return v && /^[a-z0-9_]+$/.test(v) ? v : fallback
}

// --- Message formatting ---

function helpMessage(currency: string): string {
    return [
        "<b>Donation Bot (Plisio)</b>",
        "",
        "Support us with a crypto donation.",
        "",
        `<code>/donate 10</code> — donate 10 ${currency.toUpperCase()}`,
        `<code>/donate 15 usd btc</code> — donate 15 USD, pay in BTC`,
        "<code>/status</code> — check your latest donation",
    ].join("\n")
}

function invoiceCreatedMessage(r: DonationRecord): string {
    const lines = [
        "<b>Invoice created</b>",
        `Order: <code>${escapeHtml(r.orderId)}</code>`,
        `Amount: <b>${escapeHtml(formatAmount(r.amount, r.sourceCurrency))}</b>`,
    ]
    if (r.cryptoCurrency) {
        lines.push(`Pay in: <b>${escapeHtml(r.cryptoCurrency.toUpperCase())}</b>`)
    }
    return lines.join("\n")
}

function statusMessage(r: DonationRecord): string {
    const lines = [
        `Donation <code>${escapeHtml(r.orderId)}</code>`,
        `Status: <b>${escapeHtml(r.status)}</b>`,
        `Requested: <b>${escapeHtml(formatAmount(r.amount, r.sourceCurrency))}</b>`,
    ]
    if (r.cryptoAmount && r.cryptoCurrency) {
        lines.push(`Crypto: ${escapeHtml(formatAmount(r.cryptoAmount, r.cryptoCurrency))}`)
    }
    if (r.walletHash) {
        lines.push(`Wallet: <code>${escapeHtml(r.walletHash)}</code>`)
    }
    lines.push(`Updated: ${new Date(r.updatedAt).toLocaleString("en-US")}`)
    return lines.join("\n")
}

function thankYouMessage(r: DonationRecord): string {
    const lines = [
        `<b>Thank you for your donation, ${escapeHtml(r.displayName)}!</b>`,
        `Order: <code>${escapeHtml(r.orderId)}</code>`,
        `Status: <b>${escapeHtml(r.status)}</b>`,
    ]
    if (r.cryptoAmount && r.cryptoCurrency) {
        lines.push(`Received: <b>${escapeHtml(formatAmount(r.cryptoAmount, r.cryptoCurrency))}</b>`)
    }
    return lines.join("\n")
}

// --- Keyboards ---

function presetKeyboard(currency: string, presets: number[]): InlineKeyboard {
    const kb = new InlineKeyboard()
    for (let i = 0; i < presets.length; i++) {
        kb.text(`${presets[i]} ${currency.toUpperCase()}`, `donate:${presets[i]}:${currency}`)
        if (i < presets.length - 1) kb.row()
    }
    kb.row().text("Check status", "status:latest")
    return kb
}

function donationKeyboard(r: DonationRecord): InlineKeyboard {
    const kb = new InlineKeyboard()
    if (r.invoiceUrl) kb.url("Pay now", r.invoiceUrl)
    kb.text("Refresh", `status:${r.orderId}`)
    return kb
}

// --- Main ---

export async function app(config: Config) {
    const debug = config.localDebug ?? false
    const webhookUrl = config.webhookUrl.replace(/\/+$/, "")
    const apiKey = config.plisioApiKey ?? process.env.PLISIO_API_KEY ?? ""
    const secretKey = config.plisioSecretKey ?? process.env.PLISIO_SECRET_KEY ?? ""
    const baseCurrency = normalizeTicker(config.baseCurrency ?? process.env.PLISIO_BASE_CURRENCY, DEFAULT_CURRENCY)
    const presets = (config.donationPresets ?? DEFAULT_PRESETS).filter((n) => Number.isFinite(n) && n > 0)

    if (!apiKey) console.warn("[plisio-bot] PLISIO_API_KEY is not set — invoice creation will fail")
    if (!secretKey) console.warn("[plisio-bot] PLISIO_SECRET_KEY is not set — callback verification disabled")

    const bot = new Bot(config.botToken)

    // periodic cleanup
    const cleanupTimer = setInterval(() => {
        pruneOldRecords()
        pruneRateLimiter()
    }, CLEANUP_INTERVAL_MS)
    cleanupTimer.unref()

    // --- Plisio API ---

    async function createInvoice(
        amount: number,
        sourceCurrency: string,
        orderId: string,
        description: string,
        payCurrency?: string,
    ): Promise<PlisioInvoiceResponse> {
        const params = new URLSearchParams({
            api_key: apiKey,
            currency: payCurrency || "BTC",
            order_name: "Donation",
            order_number: orderId,
            amount: amount.toString(),
            source_currency: sourceCurrency.toUpperCase(),
            description,
            callback_url: `${webhookUrl}/callback`,
        })

        if (payCurrency) {
            params.set("currency", payCurrency.toUpperCase())
        } else {
            // let user choose on invoice page
            params.delete("currency")
            params.set("allowed_psys_cids", "BTC,ETH,LTC,USDT,TRX,DOGE,XMR")
        }

        const resp = await fetch(`${PLISIO_API}/invoices/new?${params}`)
        if (!resp.ok) {
            const text = await resp.text()
            throw new Error(`Plisio ${resp.status}: ${text}`)
        }
        return (await resp.json()) as PlisioInvoiceResponse
    }

    // --- Bot commands ---

    async function handleDonate(ctx: Context, amount: number, priceCurrency: string, payCurrency?: string) {
        const chatId = ctx.chat?.id
        const userId = ctx.from?.id
        if (!chatId || !userId) {
            await ctx.reply("Could not identify your Telegram account.")
            return
        }
        if (!apiKey) {
            await ctx.reply("Plisio is not configured yet.")
            return
        }

        await ctx.replyWithChatAction("typing")

        const orderId = `tg-${userId}-${Date.now()}`
        const invoice = await createInvoice(
            amount,
            priceCurrency,
            orderId,
            `Donation from ${describeUser(ctx)}`,
            payCurrency,
        )

        if (invoice.status !== "success" || !invoice.data) {
            await ctx.reply(`Failed to create invoice: ${invoice.message ?? "unknown error"}`)
            return
        }

        const record: DonationRecord = {
            chatId,
            userId,
            displayName: describeUser(ctx),
            orderId,
            txnId: invoice.data.txn_id,
            invoiceUrl: invoice.data.invoice_url,
            amount,
            sourceCurrency: priceCurrency,
            cryptoCurrency: payCurrency ?? invoice.data.psys_cid,
            cryptoAmount: invoice.data.amount,
            walletHash: invoice.data.wallet_hash,
            status: "new",
            createdAt: Date.now(),
            updatedAt: Date.now(),
            thanked: false,
        }

        donations.set(orderId, record)
        if (record.txnId) txnToOrder.set(record.txnId, orderId)
        userLatestOrder.set(userId, orderId)
        enforceMaxRecords()

        await ctx.reply(invoiceCreatedMessage(record), {
            parse_mode: "HTML",
            reply_markup: donationKeyboard(record),
            link_preview_options: { is_disabled: true },
        })
    }

    bot.command(["start", "help"], async (ctx) => {
        await ctx.reply(helpMessage(baseCurrency), {
            parse_mode: "HTML",
            reply_markup: presetKeyboard(baseCurrency, presets),
        })
    })

    bot.command("donate", async (ctx) => {
        const parts = (ctx.match?.toString() ?? "").trim().split(/\s+/).filter(Boolean)
        if (parts.length === 0) {
            await ctx.reply(`Usage: <code>/donate 10</code> or <code>/donate 15 usd btc</code>`, {
                parse_mode: "HTML",
                reply_markup: presetKeyboard(baseCurrency, presets),
            })
            return
        }

        const amount = normalizeAmount(parts[0])
        if (!Number.isFinite(amount) || amount <= 0) {
            await ctx.reply("Amount must be a positive number.")
            return
        }

        const currency = normalizeTicker(parts[1], baseCurrency)
        const payCurrency = normalizeTicker(parts[2]) || undefined

        try {
            await handleDonate(ctx, amount, currency, payCurrency)
        } catch (err) {
            console.error("[plisio-bot] donate error:", err)
            await ctx.reply("Failed to create the invoice. Please try again later.")
        }
    })

    bot.command("status", async (ctx) => {
        const userId = ctx.from?.id
        if (!userId) return

        const input = ctx.match?.toString().trim()
        const orderId = input || userLatestOrder.get(userId)
        if (!orderId) {
            await ctx.reply("No donations found. Use /donate first.")
            return
        }

        const record = donations.get(orderId)
        if (!record || record.userId !== userId) {
            await ctx.reply("Donation not found.")
            return
        }

        await ctx.reply(statusMessage(record), {
            parse_mode: "HTML",
            reply_markup: donationKeyboard(record),
            link_preview_options: { is_disabled: true },
        })
    })

    bot.on("callback_query:data", async (ctx) => {
        const data = ctx.callbackQuery.data

        if (data.startsWith("donate:")) {
            const [, amountStr, currencyStr] = data.split(":")
            const amount = normalizeAmount(amountStr)
            const currency = normalizeTicker(currencyStr, baseCurrency)
            if (!Number.isFinite(amount) || amount <= 0) {
                await ctx.answerCallbackQuery({ text: "Invalid amount." })
                return
            }
            try {
                await handleDonate(ctx, amount, currency)
                await ctx.answerCallbackQuery({ text: "Invoice created." })
            } catch (err) {
                console.error("[plisio-bot] preset donate error:", err)
                await ctx.answerCallbackQuery({ text: "Failed to create invoice." })
            }
            return
        }

        if (data === "status:latest") {
            const userId = ctx.from?.id
            if (!userId) return
            const orderId = userLatestOrder.get(userId)
            if (!orderId || !donations.has(orderId)) {
                await ctx.answerCallbackQuery({ text: "No donations found." })
                return
            }
            const record = donations.get(orderId)!
            await ctx.answerCallbackQuery({ text: "Refreshing..." })
            await ctx.reply(statusMessage(record), {
                parse_mode: "HTML",
                reply_markup: donationKeyboard(record),
                link_preview_options: { is_disabled: true },
            })
            return
        }

        if (data.startsWith("status:")) {
            const orderId = data.slice("status:".length)
            const record = donations.get(orderId)
            if (!record) {
                await ctx.answerCallbackQuery({ text: "Donation expired from cache." })
                return
            }
            await ctx.answerCallbackQuery({ text: "Refreshing..." })
            await ctx.reply(statusMessage(record), {
                parse_mode: "HTML",
                reply_markup: donationKeyboard(record),
                link_preview_options: { is_disabled: true },
            })
        }
    })

    bot.on("message:text", async (ctx) => {
        if (ctx.message?.text?.startsWith("/")) return
        await ctx.reply("Use /donate to create a donation or /help for commands.", {
            reply_markup: presetKeyboard(baseCurrency, presets),
        })
    })

    await bot.api.setMyCommands([
        { command: "start", description: "Show help" },
        { command: "help", description: "Show commands" },
        { command: "donate", description: "Create donation: /donate 10 usd btc" },
        { command: "status", description: "Check latest donation status" },
    ])

    // --- HTTP app ---

    const elysia = new Elysia()

    elysia.get("/aboutbot", () => ({
        bot: "PlisioDonationBot",
        plisioConfigured: Boolean(apiKey),
        signatureVerification: Boolean(secretKey),
        baseCurrency,
    }))

    // Plisio callback endpoint
    elysia.post("/callback", async ({ request, set }) => {
        // Rate limit by IP
        const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
            ?? request.headers.get("cf-connecting-ip")
            ?? "unknown"

        if (isRateLimited(ip)) {
            set.status = 429
            return { ok: false, error: "too many requests" }
        }

        let body: PlisioCallback
        try {
            body = (await request.json()) as PlisioCallback
        } catch {
            // try form-urlencoded (Plisio may send either)
            try {
                const text = await request.text()
                body = Object.fromEntries(new URLSearchParams(text)) as unknown as PlisioCallback
            } catch {
                set.status = 400
                return { ok: false, error: "invalid body" }
            }
        }

        // Verify signature
        if (secretKey) {
            if (!verifyPlisioSignature(body, secretKey)) {
                set.status = 401
                return { ok: false, error: "invalid signature" }
            }
        }

        // Find donation record
        const orderId = body.order_number
        const txnId = body.txn_id
        const resolvedOrderId = orderId
            ?? (txnId ? txnToOrder.get(txnId) : undefined)

        if (!resolvedOrderId) {
            return { ok: true, ignored: true }
        }

        const record = donations.get(resolvedOrderId)
        if (!record) {
            return { ok: true, ignored: true }
        }

        // Update record
        const prevStatus = record.status
        if (body.status) record.status = body.status
        if (body.amount) record.cryptoAmount = body.amount
        if (body.currency) record.cryptoCurrency = body.currency
        if (body.wallet_hash) record.walletHash = body.wallet_hash
        if (txnId && !record.txnId) {
            record.txnId = txnId
            txnToOrder.set(txnId, resolvedOrderId)
        }
        record.updatedAt = Date.now()

        // Thank user on first completed/mismatch payment
        const thankStatuses = new Set(["completed", "mismatch"])
        if (!record.thanked && thankStatuses.has(record.status)) {
            record.thanked = true
            try {
                await bot.api.sendMessage(record.chatId, thankYouMessage(record), {
                    parse_mode: "HTML",
                    reply_markup: donationKeyboard(record),
                })
            } catch (err) {
                console.error("[plisio-bot] thank-you send error:", err)
            }
        }

        // Notify on any status change
        if (record.status !== prevStatus) {
            try {
                await bot.api.sendMessage(record.chatId, statusMessage(record), {
                    parse_mode: "HTML",
                    reply_markup: donationKeyboard(record),
                })
            } catch (err) {
                console.error("[plisio-bot] status notification error:", err)
            }
        }

        return { ok: true }
    })

    // Webhook or polling
    if (debug) {
        bot.start()
    } else {
        elysia.post("/", webhookCallback(bot, "elysia", { secretToken: config.secretToken }))
        await bot.api.setWebhook(webhookUrl, {
            secret_token: config.secretToken,
            allowed_updates: ["message", "callback_query"],
        })
    }

    return elysia
}
