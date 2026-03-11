// graceful shutdown
const shutdown = async (signal: string) => {
    console.log(`\n🛑 Received ${signal}. Shutting down gracefully...`)
    process.exit(0)
}

process.on("SIGINT", () => shutdown("SIGINT"))   // Ctrl+C
process.on("SIGTERM", () => shutdown("SIGTERM")) // Docker, process managers, etc.