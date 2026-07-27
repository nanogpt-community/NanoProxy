"use strict";

const fs = require("node:fs");

// ANSI color codes
const C = {
    reset: "\x1b[0m",
    cyan: "\x1b[1;36m",
    green: "\x1b[1;32m",
    red: "\x1b[1;31m",
    yellow: "\x1b[1;33m",
    magenta: "\x1b[1;35m",
    blue: "\x1b[1;34m",
    dimYellow: "\x1b[0;33m",
    white: "\x1b[1;37m",
    gray: "\x1b[0;90m",
    bold: "\x1b[1m",
};

const MAX_DISPLAY = 10;
const HEADERS = ["#", "Method", "Path", "Status", "Model", "Mode", "Tools", "Tokens", "Cost", "Finish"];
const ALIGNS = ["right", "left", "left", "left", "left", "left", "right", "left", "right", "left"];
const MIN_WIDTHS = HEADERS.map(h => h.length);
const ANSI_ENABLED = !!process.stdout.isTTY;

const displayRows = [];
const totals = { requests: 0, tokensIn: 0, tokensOut: 0, tokensTotal: 0, cached: 0, cost: 0, toolCalls: 0, bridges: 0 };
let tableDrawn = false;

function visLen(s) {
    return String(s).replace(/\x1b\[[0-9;]*m/g, "").length;
}

function pad(str, width, align) {
    const s = String(str);
    const diff = Math.max(0, width - visLen(s));
    return align === "right" ? " ".repeat(diff) + s : s + " ".repeat(diff);
}

function truncate(str, maxLen) {
    const s = String(str);
    return s.length <= maxLen ? s : s.slice(0, maxLen - 1) + "~";
}

/** Extract plain text values for a row */
function rowValues(r) {
    return [
        String(r.num || ""),
        r.method || "-",
        r.path || "-",
        String(r.status || "-"),
        r.model || "-",
        r.bridgeMode || "-",
        r.toolCount != null ? String(r.toolCount) : "-",
        r.tokensStr || "-",
        r.costStr || "-",
        r.finishReason || "-",
    ];
}

/** Colorize value by column index */
function colorize(val, idx, row) {
    if (!ANSI_ENABLED) return val;
    switch (idx) {
        case 0: return `${C.cyan}${val}${C.reset}`;
        case 1: return `${C.white}${val}${C.reset}`;
        case 2: return `${C.white}${val}${C.reset}`;
        case 3: { const n = parseInt(val); return `${(n >= 400 ? C.red : C.green)}${val}${C.reset}`; }
        case 4: return `${C.yellow}${val}${C.reset}`;
        case 5: return `${C.yellow}${val}${C.reset}`;
        case 6: return `${C.magenta}${val}${C.reset}`;
        case 7: return `${C.blue}${val}${C.reset}`;
        case 8: return `${C.dimYellow}${val}${C.reset}`;
        case 9: return `${C.white}${val}${C.reset}`;
        default: return val;
    }
}

/** Calculate column widths from all visible rows */
function calcWidths() {
    const widths = MIN_WIDTHS.slice();
    const padded = [...displayRows];
    while (padded.length < MAX_DISPLAY) padded.push({});
    for (const r of padded) {
        const vals = rowValues(r);
        for (let i = 0; i < vals.length; i++) {
            widths[i] = Math.max(widths[i], vals[i].length);
        }
    }
    return widths;
}

function buildSep(widths, connector) {
    return ` ${widths.map(w => "─".repeat(w)).join(connector)}`;
}

function buildHeader(widths) {
    const label = ANSI_ENABLED ? `${C.bold}${C.white}` : "";
    const reset = ANSI_ENABLED ? C.reset : "";
    const cells = HEADERS.map((h, i) => pad(`${label}${h}${reset}`, widths[i], ALIGNS[i]));
    return ` ${cells.join(" │ ")}`;
}

function buildRow(r, widths) {
    const vals = rowValues(r);
    const cells = vals.map((v, i) => {
        const display = visLen(v) > widths[i] ? truncate(v, widths[i]) : v;
        return pad(colorize(display, i, r), widths[i], ALIGNS[i]);
    });
    return ` ${cells.join(" │ ")}`;
}

function buildSummaryLine() {
    const t = totals;
    const tok = `${t.tokensIn}->${t.tokensOut}/${t.tokensTotal}`;
    const cachedStr = t.cached > 0 ? ` (${t.cached} cached)` : "";
    if (!ANSI_ENABLED) return ` Total: ${t.requests} requests │ ${tok}${cachedStr} │ $${t.cost.toFixed(5)} │ ${t.toolCalls} tool calls │ ${t.bridges} bridged`;
    return `${C.bold}${C.white} Total:${C.reset} ${C.cyan}${t.requests}${C.reset} requests │ ${C.blue}${tok}${cachedStr}${C.reset} │ ${C.dimYellow}$${t.cost.toFixed(5)}${C.reset} │ ${C.magenta}${t.toolCalls} tool calls${C.reset} │ ${C.yellow}${t.bridges} bridged${C.reset}`;
}

function redrawTable() {
    if (!ANSI_ENABLED) return;
    const widths = calcWidths();
    const padded = [...displayRows];
    while (padded.length < MAX_DISPLAY) padded.push({});
    const lines = 4 + MAX_DISPLAY; // summary + 2 seps + header + 10 rows

    if (tableDrawn) {
        process.stdout.write(`\x1b[${lines}A\x1b[0J`);
    }
    process.stdout.write("\x1b[?25l");
    console.log(buildSummaryLine());
    console.log(buildSep(widths, "─┼─"));
    console.log(buildHeader(widths));
    console.log(buildSep(widths, "─┼─"));
    for (const r of padded) console.log(buildRow(r, widths));
    process.stdout.write("\x1b[?25h");
    tableDrawn = true;
}

/** @param {{reqNum: number, method: string, url: string, status: number, model?: string, bridgeMode?: string, toolCount?: number, usage?: object|null, finishReason?: string, cost?: number}} opts */
function logRequestSummary(opts) {
    const { reqNum, method, url, status, model, bridgeMode, toolCount, usage, finishReason, cost } = opts;
    const t = totals;
    t.requests++;
    if (usage) {
        t.tokensIn += usage.prompt_tokens ?? usage.input_tokens ?? 0;
        t.tokensOut += usage.completion_tokens ?? 0;
        t.tokensTotal += usage.total_tokens ?? 0;
        t.cached += usage.cache_read_input_tokens ?? 0;
    }
    const costValue = cost ?? usage?.cost;
    if (costValue != null) t.cost += Number(costValue);
    if (toolCount != null && toolCount > 0) t.toolCalls += toolCount;
    if (bridgeMode && bridgeMode.startsWith("bridge")) t.bridges++;

    let tokensStr = "-";
    if (usage) {
        const prompt = usage.prompt_tokens ?? usage.input_tokens ?? "?";
        const completion = usage.completion_tokens ?? "?";
        const total = usage.total_tokens ?? "?";
        tokensStr = `${prompt}->${completion}/${total}`;
        if (usage.cache_read_input_tokens > 0) tokensStr += ` (c:${usage.cache_read_input_tokens})`;
    }
    const costStr = costValue != null ? `$${Number(costValue).toFixed(5)}` : "-";

    const row = { num: reqNum, method, path: url, status, model, bridgeMode, toolCount, tokensStr, costStr, finishReason };
    displayRows.push(row);
    if (displayRows.length > MAX_DISPLAY) displayRows.shift();
    redrawTable();
}

/** @param {string} logDir @param {boolean} enabled @returns {{log: function(string): void, logSection: function(string, any): void, flush: function(): void, sessionLog: string|null}} */
function createSessionLogger(logDir, enabled) {
    const sessionStart = new Date().toISOString().replace(/[:.]/g, "-");
    const sessionLog = enabled ? require("node:path").join(logDir, `session-${sessionStart}.log`) : null;
    let pending = [];
    const FLUSH_INTERVAL_MS = 250;
    let timer = null;
    function scheduleFlush() {
        if (timer || pending.length === 0) return;
        timer = setInterval(() => {
            if (pending.length === 0) {
                clearInterval(timer);
                timer = null;
                return;
            }
            const chunk = pending.join("");
            pending = [];
            try { fs.appendFileSync(sessionLog, chunk, "utf8"); } catch { }
        }, FLUSH_INTERVAL_MS);
        if (typeof timer.unref === "function") timer.unref();
    }

    function log(text) {
        if (!enabled || !sessionLog) return;
        pending.push(String(text) + "\n");
        scheduleFlush();
    }

    function logSection(title, content) {
        log(`--- ${title} ---`);
        log(typeof content === "string" ? content : JSON.stringify(content, null, 2));
        log("");
    }

    function flush() {
        if (pending.length === 0) return;
        const chunk = pending.join("");
        pending = [];
        try { fs.appendFileSync(sessionLog, chunk, "utf8"); } catch { }
    }

    return { log, logSection, flush, sessionLog };
}

module.exports = { C, pad, truncate, logRequestSummary, createSessionLogger };
