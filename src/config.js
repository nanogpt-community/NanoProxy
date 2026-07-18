"use strict";

const fs = require("node:fs");
const path = require("node:path");

// Try to load nanoproxy.json from project root or CWD
const CONFIG_NAMES = ["nanoproxy.json", "nanoproxy.config.json"];
let fileConfig = {};

for (const name of CONFIG_NAMES) {
    // Try project root (parent of src/)
    const projectRoot = path.resolve(__dirname, "..");
    const candidates = [
        path.join(projectRoot, name),
        path.join(process.cwd(), name),
    ];
    for (const p of candidates) {
        try {
            if (fs.existsSync(p)) {
                fileConfig = JSON.parse(fs.readFileSync(p, "utf8"));
                break;
            }
        } catch { /* ignore parse errors */ }
    }
    if (Object.keys(fileConfig).length > 0) break;
}

/**
 * Config resolution order:
 * 1. nanoproxy.json / nanoproxy.config.json (project root or CWD)
 * 2. Environment variables (override config file)
 */
const config = {
    // Server
    upstreamBaseUrl: process.env.UPSTREAM_BASE_URL || fileConfig.upstreamBaseUrl || "https://nano-gpt.com/api/v1",
    host: process.env.PROXY_HOST || fileConfig.host || "127.0.0.1",
    port: Number(process.env.PROXY_PORT || fileConfig.port || "8787"),

    // Bridge
    bridgeProtocol: process.env.BRIDGE_PROTOCOL || fileConfig.bridgeProtocol || "object",
    bridgeModels: process.env.BRIDGE_MODELS ?? fileConfig.bridgeModels ?? "",
    includeUsage: process.env.NANOPROXY_INCLUDE_USAGE ?? fileConfig.includeUsage ?? "",

    // Debug / Logging
    debug: process.env.NANO_PROXY_DEBUG === "1" || process.env.NANO_PROXY_DEBUG === "true" || fileConfig.debug || false,
    rawLogs: process.env.NANOPROXY_RAW_LOGS === "1" || process.env.NANOPROXY_RAW_LOGS === "true" || fileConfig.rawLogs || false,
    logDir: process.env.NANOPROXY_LOG_DIR || fileConfig.logDir || null,

    // Compression
    compression: process.env.NANOPROXY_COMPRESSION === "1" || process.env.NANOPROXY_COMPRESSION === "true" || fileConfig.compression || false,
};

module.exports = config;
