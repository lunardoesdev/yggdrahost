import { createHmac, timingSafeEqual } from "node:crypto"

import { Elysia } from "elysia"
import { Bot, Context, InlineKeyboard, webhookCallback } from "grammy"

type Config = {
    webhookUrl: string
    botToken: string
    secretToken: string
    localDebug?: boolean
    nowPaymentsApiKey?: string
    nowPaymentsIpnSecret?: string
    supportBaseCurrency?: string
    donationPresets?: number[]
}

type NowPaymentsInvoiceRequest = {
    price_amount: number
    price_currency: string
    pay_currency?: string
    ipn_callback_url?: string
    order_id?: string
    order_description?: string
    success_url?: string
    cancel_url?: string
    is_fixed_rate?: boolean
    is_fee_paid_by_user?: boolean
}

type NowPaymentsInvoiceResponse = {
    id?: string | number
    invoice_url?: string
    order_id?: string
    price_amount?: string | number
    price_currency?: string
    pay_currency?: string | null
    created_at?: string
    updated_at?: string
}

type NowPaymentsPaymentResponse = {
    payment_id?: string | number
    parent_payment_id?: string | number | null
    invoice_id?: string | number | null
    payment_status?: string
    pay_address?: string
    payin_extra_id?: string | null
    price_amount?: string | number
    price_currency?: string
    pay_amount?: string | number
    actually_paid?: string | number
    actually_paid_at_fiat?: string | number
    pay_currency?: string
    order_id?: string | null
    order_description?: string | null
    purchase_id?: string | number
    outcome_amount?: string | number
    outcome_currency?: string
    created_at?: string
    updated_at?: string
}

type DonationRecord = {
    chatId: number
    userId: number
    userDisplayName: string
    orderId: string
    invoiceId?: string
    invoiceUrl?: string
    paymentId?: string
    priceAmount: number
    priceCurrency: string
    requestedPayCurrency?: string
    payCurrency?: string
    payAmount?: string
    actuallyPaid?: string
    outcomeAmount?: string
    outcomeCurrency?: string
    payAddress?: string
    status: string
    createdAt: number
    updatedAt: number
    thankedAt?: number
    lastSource: "invoice" | "ipn" | "status"
}

const NOWPAYMENTS_BASE_URL = "https://api.nowpayments.io/v1"
const DEFAULT_PRICE_CURRENCY = "usd"
const DEFAULT_DONATION_PRESETS = [5, 10, 25]
const TERMINAL_PAYMENT_STATUSES = new Set([
    "finished",
    "failed",
    "expired",
    "refunded",
    "partially_paid",
    "cancelled",
])

const donationsByOrderId = new Map<string, DonationRecord>()
const orderIdByPaymentId = new Map<string, string>()
const latestOrderIdByUser = new Map<number, string>()

function normalizeTicker(value: string | undefined, fallback = "") {
    const normalized = value?.trim().toLowerCase()
    return normalized && /^[a-z0-9_]+$/.test(normalized) ? normalized : fallback
}

function normalizeAmount(input: string | undefined) {
    if (!input) {
        return Number.NaN
    }

    const parsed = Number.parseFloat(input.replace(",", "."))
    return Number.isFinite(parsed) ? parsed : Number.NaN
}

function formatAmount(value: number | string | undefined, currency: string | undefined) {
    if (value === undefined || value === "") {
        return "unknown"
    }

    return `${value} ${currency?.toUpperCase() || ""}`.trim()
}

function escapeHtml(value: string) {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll("\"", "&quot;")
}

function trimTrailingSlash(value: string) {
    return value.replace(/\/+$/, "")
}

function toOptionalString(value: string | number | null | undefined) {
    if (value === null || value === undefined) {
        return undefined
    }

    const stringValue = String(value).trim()
    return stringValue.length > 0 ? stringValue : undefined
}

function sortObjectDeep(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map((item) => sortObjectDeep(item))
    }

    if (!value || typeof value !== "object") {
        return value
    }

    return Object.keys(value as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((result, key) => {
            result[key] = sortObjectDeep((value as Record<string, unknown>)[key])
            return result
        }, {})
}

function verifyIpnSignature(rawBody: string, signature: string | null, secret: string) {
    if (!signature || !secret.trim()) {
        return false
    }

    let parsedBody: unknown
    try {
        parsedBody = JSON.parse(rawBody) as unknown
    } catch {
        return false
    }

    const sortedBody = JSON.stringify(sortObjectDeep(parsedBody))
    const digest = createHmac("sha512", secret.trim()).update(sortedBody).digest("hex")
    const expected = Buffer.from(digest, "utf8")
    const received = Buffer.from(signature, "utf8")

    if (expected.length !== received.length) {
        return false
    }

    return timingSafeEqual(expected, received)
}

function buildPresetKeyboard(baseCurrency: string, presets: number[]) {
    const keyboard = new InlineKeyboard()

    presets.forEach((amount, index) => {
        keyboard.text(
            `${amount} ${baseCurrency.toUpperCase()}`,
            `donate:${amount}:${baseCurrency}`,
        )

        if (index < presets.length - 1) {
            keyboard.row()
        }
    })

    keyboard.row().text("Latest status", "status:latest")
    return keyboard
}

function buildDonationKeyboard(record: DonationRecord) {
    const keyboard = new InlineKeyboard()

    if (record.invoiceUrl) {
        keyboard.url("Open payment page", record.invoiceUrl)
    }

    keyboard.text("Refresh status", `status:${record.orderId}`)
    return keyboard
}

function formatStatusMessage(record: DonationRecord) {
    const lines = [
        `Donation #${escapeHtml(record.orderId)}`,
        `Status: <b>${escapeHtml(record.status)}</b>`,
        `Requested: <b>${escapeHtml(formatAmount(record.priceAmount, record.priceCurrency))}</b>`,
    ]

    if (record.requestedPayCurrency) {
        lines.push(`Requested coin: <b>${escapeHtml(record.requestedPayCurrency.toUpperCase())}</b>`)
    }

    if (record.payCurrency || record.payAmount) {
        lines.push(`Payment target: ${escapeHtml(formatAmount(record.payAmount, record.payCurrency))}`)
    }

    if (record.actuallyPaid) {
        lines.push(`Actually paid: ${escapeHtml(formatAmount(record.actuallyPaid, record.payCurrency))}`)
    }

    if (record.outcomeAmount || record.outcomeCurrency) {
        lines.push(`Merchant outcome: ${escapeHtml(formatAmount(record.outcomeAmount, record.outcomeCurrency))}`)
    }

    if (record.payAddress) {
        lines.push(`Address: <code>${escapeHtml(record.payAddress)}</code>`)
    }

    if (record.invoiceUrl) {
        lines.push(`Invoice: ${escapeHtml(record.invoiceUrl)}`)
    }

    lines.push(`Updated: ${escapeHtml(new Date(record.updatedAt).toLocaleString("en-US"))}`)
    return lines.join("\n")
}

function formatDonationCreatedMessage(record: DonationRecord) {
    const lines = [
        `<b>Donation invoice created</b>`,
        `Order: <code>${escapeHtml(record.orderId)}</code>`,
        `Amount: <b>${escapeHtml(formatAmount(record.priceAmount, record.priceCurrency))}</b>`,
    ]

    if (record.requestedPayCurrency) {
        lines.push(`Preferred coin: <b>${escapeHtml(record.requestedPayCurrency.toUpperCase())}</b>`)
    } else {
        lines.push(`Coin: choose any coin supported by your NOWPayments checkout`)
    }

    lines.push("Status updates will appear here after NOWPayments sends the first payment webhook.")
    return lines.join("\n")
}

function hasPositiveAmount(value: string | undefined) {
    if (!value) {
        return false
    }

    const parsed = Number.parseFloat(value)
    return Number.isFinite(parsed) && parsed > 0
}

function shouldSendThankYou(record: DonationRecord) {
    if (record.thankedAt) {
        return false
    }

    if (hasPositiveAmount(record.actuallyPaid)) {
        return true
    }

    return ["confirming", "confirmed", "finished", "partially_paid"].includes(record.status)
}

function formatThankYouMessage(record: DonationRecord) {
    const lines = [
        `<b>Thank you for your donation, ${escapeHtml(record.userDisplayName)}.</b>`,
        `We received your contribution for order <code>${escapeHtml(record.orderId)}</code>.`,
        `Current status: <b>${escapeHtml(record.status)}</b>`,
    ]

    if (record.actuallyPaid) {
        lines.push(`Received: <b>${escapeHtml(formatAmount(record.actuallyPaid, record.payCurrency))}</b>`)
    } else if (record.payAmount || record.payCurrency) {
        lines.push(`Expected crypto amount: <b>${escapeHtml(formatAmount(record.payAmount, record.payCurrency))}</b>`)
    }

    lines.push("I will keep posting status updates here if NOWPayments reports further changes.")
    return lines.join("\n")
}

function formatHelpText(baseCurrency: string) {
    return [
        "<b>SupportBot</b>",
        "",
        "Create a donation invoice with NOWPayments and pay it in crypto.",
        "",
        `<code>/donate 10 ${baseCurrency}</code>`,
        `<code>/donate 15 usd btc</code>`,
        "<code>/status</code>",
        "<code>/currencies</code>",
        "",
        `Default price currency: <b>${escapeHtml(baseCurrency.toUpperCase())}</b>`,
    ].join("\n")
}

function getConfigWarning(apiKey: string, ipnSecret: string) {
    if (!apiKey) {
        return "NOWPayments is not configured yet. Set NOWPAYMENTS_API_KEY first."
    }

    if (!ipnSecret) {
        return "NOWPAYMENTS_IPN_SECRET is missing. Invoices will work, but automatic payment status updates will stay limited until the IPN secret is configured."
    }

    return undefined
}

type ParsedDonateCommand =
    | {
        error: string
    }
    | {
        amount: number
        priceCurrency: string
        payCurrency?: string
    }

function parseDonateCommand(input: string, baseCurrency: string): ParsedDonateCommand {
    const parts = input.trim().split(/\s+/).filter(Boolean)

    if (parts.length === 0) {
        return {
            error: `Usage: /donate <amount> [price_currency] [pay_currency]\nExample: /donate 10 ${baseCurrency}\nExample: /donate 15 usd btc`,
        }
    }

    const amount = normalizeAmount(parts[0])
    if (!Number.isFinite(amount) || amount <= 0) {
        return {
            error: "Donation amount must be a positive number.",
        }
    }

    const priceCurrency = normalizeTicker(parts[1], baseCurrency)
    const payCurrency = normalizeTicker(parts[2])

    return {
        amount,
        priceCurrency,
        payCurrency,
    }
}

function describeUser(ctx: Context) {
    const first = ctx.from?.first_name?.trim()
    const last = ctx.from?.last_name?.trim()
    const username = ctx.from?.username?.trim()
    const fullName = [first, last].filter(Boolean).join(" ").trim()

    if (fullName) {
        return username ? `${fullName} (@${username})` : fullName
    }

    if (username) {
        return `@${username}`
    }

    return `telegram-user-${ctx.from?.id ?? "unknown"}`
}

function updateRecordFromPayment(
    record: DonationRecord,
    payment: NowPaymentsPaymentResponse,
    source: DonationRecord["lastSource"],
) {
    const paymentId = toOptionalString(payment.payment_id) ?? toOptionalString(payment.purchase_id)
    if (paymentId) {
        record.paymentId = paymentId
        orderIdByPaymentId.set(paymentId, record.orderId)
    }

    record.invoiceId = toOptionalString(payment.invoice_id) ?? record.invoiceId
    record.status = payment.payment_status || record.status
    record.payAddress = payment.pay_address || record.payAddress
    record.payCurrency = payment.pay_currency || record.payCurrency
    record.payAmount = toOptionalString(payment.pay_amount) ?? record.payAmount
    record.actuallyPaid = toOptionalString(payment.actually_paid) ?? record.actuallyPaid
    record.outcomeAmount = toOptionalString(payment.outcome_amount) ?? record.outcomeAmount
    record.outcomeCurrency = payment.outcome_currency || record.outcomeCurrency
    record.updatedAt = Date.now()
    record.lastSource = source

    donationsByOrderId.set(record.orderId, record)
}

async function sendStatusNotification(bot: Bot, record: DonationRecord) {
    try {
        await bot.api.sendMessage(record.chatId, formatStatusMessage(record), {
            parse_mode: "HTML",
            reply_markup: buildDonationKeyboard(record),
        })
    } catch (error) {
        console.error("Failed to send NOWPayments status update to Telegram:", error)
    }
}

async function sendThankYouNotification(bot: Bot, record: DonationRecord) {
    try {
        await bot.api.sendMessage(record.chatId, formatThankYouMessage(record), {
            parse_mode: "HTML",
            reply_markup: buildDonationKeyboard(record),
        })
    } catch (error) {
        console.error("Failed to send thank-you message to Telegram:", error)
    }
}

export async function newSupportBot(config: Config) {
    const debug = config.localDebug || false
    const token = config.botToken
    const secretToken = config.secretToken
    const webhookUrl = trimTrailingSlash(config.webhookUrl)
    const nowPaymentsApiKey = config.nowPaymentsApiKey ?? process.env.NOWPAYMENTS_API_KEY ?? ""
    const nowPaymentsIpnSecret = config.nowPaymentsIpnSecret ?? process.env.NOWPAYMENTS_IPN_SECRET ?? ""
    const baseCurrency = normalizeTicker(
        config.supportBaseCurrency ?? process.env.SUPPORTBOT_PRICE_CURRENCY,
        DEFAULT_PRICE_CURRENCY,
    )
    const presets = (config.donationPresets ?? DEFAULT_DONATION_PRESETS).filter(
        (value) => Number.isFinite(value) && value > 0,
    )

    const bot = new Bot(token)
    const configWarning = getConfigWarning(nowPaymentsApiKey, nowPaymentsIpnSecret)
    const ipnCallbackUrl = `${webhookUrl}/ipn`

    async function nowPaymentsRequest<T>(path: string, init?: RequestInit) {
        if (!nowPaymentsApiKey) {
            throw new Error("NOWPAYMENTS_API_KEY is not configured")
        }

        const response = await fetch(`${NOWPAYMENTS_BASE_URL}${path}`, {
            ...init,
            headers: {
                "x-api-key": nowPaymentsApiKey,
                "Content-Type": "application/json",
                ...(init?.headers ?? {}),
            },
        })

        if (!response.ok) {
            const responseText = await response.text()
            throw new Error(`NOWPayments ${response.status}: ${responseText}`)
        }

        return await response.json() as T
    }

    async function createDonation(
        ctx: Context,
        amount: number,
        priceCurrency: string,
        payCurrency?: string,
    ) {
        const chatId = ctx.chat?.id
        const userId = ctx.from?.id

        if (!chatId || !userId) {
            await ctx.reply("Telegram did not provide enough user information for this request.")
            return
        }

        if (!nowPaymentsApiKey) {
            await ctx.reply("NOWPayments is not configured yet. Set NOWPAYMENTS_API_KEY and try again.")
            return
        }

        await ctx.replyWithChatAction("typing")

        const orderId = `tg-${userId}-${Date.now()}`
        const payload: NowPaymentsInvoiceRequest = {
            price_amount: amount,
            price_currency: priceCurrency,
            order_id: orderId,
            order_description: `Donation from ${describeUser(ctx)}`,
            ipn_callback_url: ipnCallbackUrl,
            is_fixed_rate: false,
            is_fee_paid_by_user: false,
        }

        if (payCurrency) {
            payload.pay_currency = payCurrency
        }

        const invoice = await nowPaymentsRequest<NowPaymentsInvoiceResponse>("/invoice", {
            method: "POST",
            body: JSON.stringify(payload),
        })

        const record: DonationRecord = {
            chatId,
            userId,
            userDisplayName: describeUser(ctx),
            orderId,
            invoiceId: toOptionalString(invoice.id),
            invoiceUrl: invoice.invoice_url,
            priceAmount: amount,
            priceCurrency,
            requestedPayCurrency: payCurrency,
            status: "invoice_created",
            createdAt: Date.now(),
            updatedAt: Date.now(),
            lastSource: "invoice",
        }

        donationsByOrderId.set(orderId, record)
        latestOrderIdByUser.set(userId, orderId)

        const lines = [formatDonationCreatedMessage(record)]
        if (configWarning) {
            lines.push("", `Warning: ${escapeHtml(configWarning)}`)
        }

        await ctx.reply(lines.join("\n"), {
            parse_mode: "HTML",
            reply_markup: buildDonationKeyboard(record),
            link_preview_options: {
                is_disabled: true,
            },
        })
    }

    async function showDonationStatus(ctx: Context, orderId?: string) {
        const userId = ctx.from?.id
        if (!userId) {
            await ctx.reply("Telegram did not provide a user id for this request.")
            return
        }

        const resolvedOrderId = orderId || latestOrderIdByUser.get(userId)
        if (!resolvedOrderId) {
            await ctx.reply("You do not have any tracked donations yet. Use /donate first.")
            return
        }

        const record = donationsByOrderId.get(resolvedOrderId)
        if (!record || record.userId !== userId) {
            await ctx.reply("I could not find that donation for your account.")
            return
        }

        if (record.paymentId && !TERMINAL_PAYMENT_STATUSES.has(record.status)) {
            try {
                const payment = await nowPaymentsRequest<NowPaymentsPaymentResponse>(`/payment/${record.paymentId}`)
                updateRecordFromPayment(record, payment, "status")
            } catch (error) {
                console.error("Failed to refresh NOWPayments payment status:", error)
            }
        }

        await ctx.reply(formatStatusMessage(record), {
            parse_mode: "HTML",
            reply_markup: buildDonationKeyboard(record),
            link_preview_options: {
                is_disabled: true,
            },
        })
    }

    bot.command(["start", "help"], async (ctx: Context) => {
        const lines = [formatHelpText(baseCurrency)]

        if (configWarning) {
            lines.push("", `Warning: ${escapeHtml(configWarning)}`)
        }

        await ctx.reply(lines.join("\n"), {
            parse_mode: "HTML",
            reply_markup: buildPresetKeyboard(baseCurrency, presets),
        })
    })

    bot.command("donate", async (ctx: Context) => {
        const input = ctx.match?.toString() ?? ""
        const parsed: ParsedDonateCommand = parseDonateCommand(input, baseCurrency)

        if ("error" in parsed) {
            await ctx.reply(parsed.error, {
                reply_markup: buildPresetKeyboard(baseCurrency, presets),
            })
            return
        }

        try {
            await createDonation(ctx, parsed.amount, parsed.priceCurrency, parsed.payCurrency)
        } catch (error) {
            console.error("Failed to create NOWPayments donation invoice:", error)
            await ctx.reply("Failed to create the donation invoice. Check the server logs and NOWPayments configuration.")
        }
    })

    bot.command("status", async (ctx: Context) => {
        const orderId = ctx.match?.toString().trim()
        await showDonationStatus(ctx, orderId || undefined)
    })

    bot.command("currencies", async (ctx: Context) => {
        if (!nowPaymentsApiKey) {
            await ctx.reply("NOWPayments is not configured yet. Set NOWPAYMENTS_API_KEY first.")
            return
        }

        try {
            const rawResponse = await nowPaymentsRequest<string[] | { currencies?: string[] }>("/currencies")
            const currencies = Array.isArray(rawResponse) ? rawResponse : (rawResponse.currencies ?? [])
            const query = normalizeTicker(ctx.match?.toString())
            const filtered = query
                ? currencies.filter((currency) => currency.toLowerCase().includes(query))
                : currencies

            if (filtered.length === 0) {
                await ctx.reply("No matching NOWPayments currencies were found.")
                return
            }

            await ctx.reply([
                `Supported currencies${query ? ` matching "${query}"` : ""}:`,
                filtered.slice(0, 60).map((currency) => currency.toUpperCase()).join(", "),
                filtered.length > 60 ? `...and ${filtered.length - 60} more.` : "",
            ].filter(Boolean).join("\n"))
        } catch (error) {
            console.error("Failed to fetch NOWPayments currencies:", error)
            await ctx.reply("Failed to load NOWPayments currencies.")
        }
    })

    bot.on("callback_query:data", async (ctx) => {
        const data = ctx.callbackQuery.data

        if (data.startsWith("donate:")) {
            const [, amountPart, currencyPart] = data.split(":")
            const amount = normalizeAmount(amountPart)
            const priceCurrency = normalizeTicker(currencyPart, baseCurrency)

            if (!Number.isFinite(amount) || amount <= 0) {
                await ctx.answerCallbackQuery({ text: "Invalid preset amount." })
                return
            }

            try {
                await createDonation(ctx, amount, priceCurrency)
                await ctx.answerCallbackQuery({ text: "Donation invoice created." })
            } catch (error) {
                console.error("Failed to create preset donation:", error)
                await ctx.answerCallbackQuery({ text: "Failed to create the donation invoice." })
            }

            return
        }

        if (data === "status:latest") {
            await ctx.answerCallbackQuery({ text: "Refreshing your latest donation." })
            await showDonationStatus(ctx)
            return
        }

        if (data.startsWith("status:")) {
            const orderId = data.slice("status:".length)
            await ctx.answerCallbackQuery({ text: "Refreshing donation status." })
            await showDonationStatus(ctx, orderId)
        }
    })

    bot.on("message:text", async (ctx: Context) => {
        const text = ctx.message?.text?.trim()

        if (!text || text.startsWith("/")) {
            return
        }

        await ctx.reply("Use /donate to create a crypto donation invoice or /help to see examples.", {
            reply_markup: buildPresetKeyboard(baseCurrency, presets),
        })
    })

    await bot.api.setMyCommands([
        { command: "start", description: "Show donation bot help" },
        { command: "help", description: "Show commands and donation examples" },
        { command: "donate", description: "Create donation invoice: /donate 10 usd btc" },
        { command: "status", description: "Show latest donation status or /status <order_id>" },
        { command: "currencies", description: "Show supported NOWPayments coins" },
    ])

    const app = new Elysia()

    app
        .get("/aboutbot", () => ({
            bot: "SupportBot",
            webhookUrl,
            nowPaymentsConfigured: Boolean(nowPaymentsApiKey),
            ipnConfigured: Boolean(nowPaymentsIpnSecret),
            priceCurrency: baseCurrency,
        }))
        .post("/ipn", async ({ request, set }) => {
            const rawBody = await request.text()

            if (!nowPaymentsIpnSecret) {
                set.status = 503
                return {
                    ok: false,
                    error: "NOWPAYMENTS_IPN_SECRET is not configured",
                }
            }

            if (!verifyIpnSignature(rawBody, request.headers.get("x-nowpayments-sig"), nowPaymentsIpnSecret)) {
                set.status = 401
                return {
                    ok: false,
                    error: "Invalid NOWPayments signature",
                }
            }

            let payload: NowPaymentsPaymentResponse
            try {
                payload = JSON.parse(rawBody) as NowPaymentsPaymentResponse
            } catch {
                set.status = 400
                return {
                    ok: false,
                    error: "Invalid JSON payload",
                }
            }

            const orderId = toOptionalString(payload.order_id)
            const paymentId = toOptionalString(payload.payment_id) ?? toOptionalString(payload.purchase_id)
            const fallbackOrderId = paymentId ? orderIdByPaymentId.get(paymentId) : undefined
            const record = donationsByOrderId.get(orderId ?? fallbackOrderId ?? "")

            if (!record) {
                return {
                    ok: true,
                    ignored: true,
                }
            }

            const previousStatus = record.status
            const previousPaymentId = record.paymentId
            updateRecordFromPayment(record, payload, "ipn")

            if (shouldSendThankYou(record)) {
                record.thankedAt = Date.now()
                donationsByOrderId.set(record.orderId, record)
                await sendThankYouNotification(bot, record)
            }

            if (record.status !== previousStatus || record.paymentId !== previousPaymentId) {
                await sendStatusNotification(bot, record)
            }

            return {
                ok: true,
            }
        })

    if (debug) {
        bot.start()
    } else {
        app.post("/", webhookCallback(bot, "elysia", {
            secretToken,
        }))

        await bot.api.setWebhook(webhookUrl, {
            secret_token: secretToken,
            allowed_updates: ["message", "callback_query"],
        })
    }

    return app
}
