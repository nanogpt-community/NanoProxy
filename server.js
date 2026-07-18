"use strict";

const http = require("node:http");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const config = require("./src/config.js");
const core = require("./src/core.js");
const { logRequestSummary, createSessionLogger, C } = require("./src/logger.js");
const { redactHeaders, buildUpstreamHeaders, copyResponseHeaders } = require("./src/headers.js");

const {
    tryParseJson,
    requestNeedsBridge,
    requestNeedsXmlBridge,
    transformRequestForBridge,
    withOptionalIncludeUsage,
    buildAggregateFromChatCompletion,
    buildChatCompletionFromBridge,
    acceptNativeJson,
    acceptNativeSSE,
    sseLine,
    createStreamingBridgeParser,
    buildBridgeResultFromText,
    getBridgeProtocol
} = core;

const LISTEN_HOST = config.host;
const LISTEN_PORT = config.port;
const UPSTREAM_BASE_URL = config.upstreamBaseUrl;
const DEBUG_FLAG_FILE = path.join(__dirname, ".debug-logging");
const ENABLE_DEBUG_LOGS = config.debug || fs.existsSync(DEBUG_FLAG_FILE);
const LOG_DIR = path.join(__dirname, "Logs");

if (ENABLE_DEBUG_LOGS) fs.mkdirSync(LOG_DIR, { recursive: true });
const { log, logSection, sessionLog: SESSION_LOG } = createSessionLogger(LOG_DIR, ENABLE_DEBUG_LOGS);
let requestCounter = 0;

function buildUpstreamUrl(requestPath) {
    const base = UPSTREAM_BASE_URL.replace(/\/+$/, "");
    const suffix = String(requestPath || "").replace(/^\/+/, "");
    return `${base}/${suffix}`;
}
async function readRequestBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
}

function nowStamp() {
    return new Date().toISOString().replace(/[:.]/g, "-");
}




const ENABLE_COMPRESSION = config.compression;

function clientAcceptsGzip(req) {
    if (!ENABLE_COMPRESSION) return false;
    return String(req.headers["accept-encoding"] || "").includes("gzip");
}

function compressIfPossible(req, res, body, contentType) {
    if (clientAcceptsGzip(req) && body.length > 256) {
        const compressed = zlib.gzipSync(body);
        res.writeHead(200, {
            "content-type": contentType,
            "content-length": String(compressed.length),
            "content-encoding": "gzip",
            "vary": "Accept-Encoding",
        });
        res.end(compressed);
    } else {
        res.writeHead(200, {
            "content-type": contentType,
            "content-length": String(body.length),
        });
        res.end(body);
    }
}
async function fetchUpstream(req, upstreamUrl, bodyBuffer) {
    return fetch(upstreamUrl, {
        method: req.method,
        headers: buildUpstreamHeaders(req.headers, bodyBuffer.length),
        body: ["GET", "HEAD"].includes(req.method) ? undefined : bodyBuffer,
    });
}

function buildInvalidBridgeRetryBuffer(rewrittenBody, protocol = "xml") {
    const retryBody = structuredClone(rewrittenBody);
    retryBody.messages = Array.isArray(retryBody.messages) ? retryBody.messages.slice() : [];
    const systemText = retryBody.messages
        .filter((message) => message && message.role === "system")
        .map((message) => typeof message.content === "string" ? message.content : "")
        .join("\n");
    const manifestMatch = systemText.match(/Tool manifest:\n([\s\S]*?)(?:\n\nAdditional system instructions|\n*$)/);
    const manifestParsed = manifestMatch ? tryParseJson(manifestMatch[1].trim()) : { ok: false };
    const toolNames = manifestParsed.ok && Array.isArray(manifestParsed.value)
        ? manifestParsed.value.map((tool) => tool && tool.name).filter(Boolean)
        : [];
    const hasAttemptCompletion = toolNames.includes("attempt_completion");
    const hasFollowup = toolNames.includes("ask_followup_question");
    const content = protocol === "object"
        ? [
            "Your previous response ended with no visible content and no tool call. That is invalid for this tool-enabled turn.",
            "You must now return exactly one JSON object that follows the Structured Turn Contract. No markdown. No prose outside the JSON object. Do not return an empty response.",
            toolNames.length ? `Available tools: ${toolNames.join(", ")}.` : "",
            hasAttemptCompletion ? 'If the task is complete, use mode "tool" and call "attempt_completion". Do not use mode "final" for completion.' : 'If no tool is needed, use mode "final" with a non-empty message.',
            hasFollowup ? 'If you need input from the user or are answering a conversational prompt, use mode "tool" and call "ask_followup_question". Do not use mode "clarify".' : 'If you need input from the user, use mode "clarify" with a non-empty question.',
            'If work remains, use mode "tool" with one of the available tools.'
        ].filter(Boolean).join("\n")
        : [
            "Your previous response ended with no visible content and no XML tool call. That is invalid for this tool-enabled turn.",
            "Do not return an empty response.",
            toolNames.length ? `Available tools: ${toolNames.join(", ")}.` : "",
            hasAttemptCompletion ? 'If the task is complete, emit the "attempt_completion" tool call.' : "If no tool is needed, provide a normal visible reply.",
            hasFollowup ? 'If you need input from the user or are answering a conversational prompt, emit the "ask_followup_question" tool call.' : "",
            "If work remains, emit the XML tool call now."
        ].filter(Boolean).join("\n");
    retryBody.messages.push({ role: "system", content });
    return Buffer.from(JSON.stringify(retryBody), "utf8");
}

async function proxyRequest(req, res) {
    if (req.method === "GET" && req.url === "/health") {
        const payload = { ok: true, mode: `${getBridgeProtocol()}-bridge`, port: LISTEN_PORT, upstream: UPSTREAM_BASE_URL, debugLogs: ENABLE_DEBUG_LOGS };
        if (ENABLE_DEBUG_LOGS) payload.logDir = LOG_DIR;
        const body = JSON.stringify(payload);
        res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
        res.end(body);
        return;
    }

    // Root endpoint
    if (req.method === "GET" && (req.url === "/" || req.url === "")) {
        const payload = { ok: true, service: "nanoproxy", mode: `${getBridgeProtocol()}-bridge`, port: LISTEN_PORT, upstream: UPSTREAM_BASE_URL };
        const body = JSON.stringify(payload);
        res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
        res.end(body);
        return;
    }

    // Path validation: warn about duplicate /v1/ prefix
    if ((req.url || "").startsWith("/v1/")) {
        console.log(`${C.yellow}[NanoProxy] Warning: path starts with /v1/ but upstream already includes /api/v1 — likely 400.${C.reset}`);
    }

    requestCounter++;
    const reqNum = requestCounter;
    const requestId = `${nowStamp()}-${randomUUID().slice(0, 8)}`;
    const upstreamUrl = buildUpstreamUrl(req.url);
    const reqBuffer = await readRequestBody(req);
    const reqText = reqBuffer.toString("utf8");
    const parsed = tryParseJson(reqText);
    const isJson = (req.headers["content-type"] || "").includes("application/json") && parsed.ok;
    const requestBody = isJson ? withOptionalIncludeUsage(parsed.value) : null;

    let upstreamBuffer = isJson
        ? Buffer.from(JSON.stringify(requestBody), "utf8")
        : reqBuffer;
    let bridgeMeta = null;
    let attemptNativeFirst = false;

    if (isJson && requestNeedsXmlBridge(requestBody) && !requestNeedsBridge(requestBody)) {
        attemptNativeFirst = true;
    }

    log(`\n${"=".repeat(80)}`);
    log(`REQUEST #${reqNum}  |  ${new Date().toISOString()}  |  ${req.method} ${req.url}`);
    log(`${"=".repeat(80)}`);
    if (ENABLE_DEBUG_LOGS) logSection("REQUEST HEADERS", redactHeaders(req.headers));

    if (isJson && requestNeedsXmlBridge(requestBody) && !attemptNativeFirst) {
        bridgeMeta = transformRequestForBridge(requestBody);
        upstreamBuffer = Buffer.from(JSON.stringify(bridgeMeta.rewritten), "utf8");
        log(`--- BRIDGE ACTIVE | Tools: [${bridgeMeta.toolNames.join(", ")}] ---\n`);
    } else if (attemptNativeFirst) {
        upstreamBuffer = Buffer.from(JSON.stringify(requestBody), "utf8");
        log(`--- NATIVE-FIRST ACTIVE | Model: ${requestBody && requestBody.model ? requestBody.model : "(unknown)"} ---\n`);
    }

    let upstreamResponse = await fetchUpstream(req, upstreamUrl, upstreamBuffer);
    let contentType = upstreamResponse.headers.get("content-type") || "";

    if (attemptNativeFirst) {
        let nativeSucceeded = false;
        let bufferedBody = null;
        let bufferedText = "";

        try {
            if (contentType.includes("text/event-stream")) {
                bufferedText = await upstreamResponse.text();
                bufferedBody = Buffer.from(bufferedText, "utf8");
                nativeSucceeded = acceptNativeSSE(upstreamResponse.status, bufferedText);
            } else if (contentType.includes("application/json")) {
                bufferedText = await upstreamResponse.text();
                bufferedBody = Buffer.from(bufferedText, "utf8");
                const nativeParsed = tryParseJson(bufferedText);
                nativeSucceeded = nativeParsed.ok && acceptNativeJson(upstreamResponse.status, nativeParsed.value);
            } else if (upstreamResponse.status >= 200 && upstreamResponse.status < 300) {
                bufferedBody = Buffer.from(await upstreamResponse.arrayBuffer());
                nativeSucceeded = true;
            }
        } catch (_) {
            nativeSucceeded = false;
        }

        log(`--- NATIVE-FIRST RESULT ---`);
        log(nativeSucceeded ? "accepted" : "rejected; falling back to xml bridge");
        log("");

        if (nativeSucceeded) {
            copyResponseHeaders(upstreamResponse.headers, res, bufferedBody ? bufferedBody.length : undefined);
            res.writeHead(upstreamResponse.status);
            if (bufferedBody) res.end(bufferedBody);
            else res.end();
            logRequestSummary({ reqNum, method: req.method, url: req.url, status: upstreamResponse.status, bridgeMode: "native", model: requestBody?.model });

            return;
        }

        bridgeMeta = transformRequestForBridge(requestBody);
        upstreamBuffer = Buffer.from(JSON.stringify(bridgeMeta.rewritten), "utf8");
        log(`--- BRIDGE ACTIVE | Tools: [${bridgeMeta.toolNames.join(", ")}] ---\n`);
        upstreamResponse = await fetchUpstream(req, upstreamUrl, upstreamBuffer);
        contentType = upstreamResponse.headers.get("content-type") || "";
    }

    if (!upstreamResponse.ok) {
        log(`--- UPSTREAM ERROR ${upstreamResponse.status} ${upstreamResponse.statusText} ---`);
        try {
            const errBody = await upstreamResponse.clone().text();
            log(errBody.substring(0, 2000));
        } catch (_) { }
        log("");
    }

    if (bridgeMeta && upstreamResponse.ok && contentType.includes("text/event-stream")) {
        res.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache, no-transform",
            connection: "keep-alive"
        });

        const id = "chatcmpl_" + randomUUID();
        let model = "nanoproxy";
        let created = Math.floor(Date.now() / 1000);
        const SSE_HEARTBEAT_INTERVAL_MS = 15000;
        let lastSseWriteAt = Date.now();
        const writeSse = (payload) => {
            lastSseWriteAt = Date.now();
            return res.write(sseLine(payload));
        };
        const writeSseComment = (text) => {
            lastSseWriteAt = Date.now();
            return res.write(`: ${text}\n\n`);
        };
        const heartbeatTimer = setInterval(() => {
            if (res.destroyed || res.writableEnded) return;
            if (Date.now() - lastSseWriteAt < SSE_HEARTBEAT_INTERVAL_MS) return;
            try { writeSseComment("keepalive"); } catch (_) { }
        }, SSE_HEARTBEAT_INTERVAL_MS);
        if (typeof heartbeatTimer.unref === "function") heartbeatTimer.unref();

        writeSse({
            id, object: "chat.completion.chunk", created, model,
            choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }]
        });

        const STRIP_TAGS = ["<open>", "</open>"];
        let stripBuf = "";
        function emitContent(text) {
            writeSse({
                id, object: "chat.completion.chunk", created, model,
                choices: [{ index: 0, delta: { content: text }, finish_reason: null }]
            });
        }
        function feedContent(char) {
            if (stripBuf.length > 0) {
                stripBuf += char;
                let couldMatch = false;
                let exactMatch = false;
                for (const tag of STRIP_TAGS) {
                    if (tag.startsWith(stripBuf)) couldMatch = true;
                    if (tag === stripBuf) exactMatch = true;
                }
                if (exactMatch) {
                    stripBuf = "";
                } else if (!couldMatch) {
                    for (const c of stripBuf) emitContent(c);
                    stripBuf = "";
                }
            } else if (char === "<") {
                stripBuf = "<";
            } else {
                emitContent(char);
            }
        }
        function flushStripBuf() {
            if (stripBuf.length > 0) {
                let exactMatch = false;
                for (const tag of STRIP_TAGS) {
                    if (tag === stripBuf) exactMatch = true;
                }
                if (!exactMatch) {
                    for (const c of stripBuf) emitContent(c);
                }
                stripBuf = "";
            }
        }

        const retryBuffer = buildInvalidBridgeRetryBuffer(bridgeMeta.rewritten, bridgeMeta.protocol);
        let activeResponse = upstreamResponse;
        let activeContentType = contentType;
        let finalToolIndex = 0;
        let finalFinishReason = null;
        let invalidNotice = null;
        let upstreamUsage = null;

        for (let attempt = 0; attempt < 2; attempt++) {
            if (!(activeResponse.ok && activeContentType.includes("text/event-stream"))) break;
            if (attempt > 0) {
                log(`--- RETRY ATTEMPT #${attempt + 1} ---`);
                log("");
            }

            const parser = createStreamingBridgeParser(bridgeMeta.normalizedTools, {
                onContent: (text) => {
                    if (bridgeMeta.protocol === "object") emitContent(text);
                    else for (const c of text) feedContent(c);
                },
                onToolCall: (call, index) => {
                    flushStripBuf();
                    writeSse({
                        id, object: "chat.completion.chunk", created, model,
                        choices: [{
                            index: 0,
                            delta: {
                                tool_calls: [{
                                    index,
                                    id: call.id,
                                    type: "function",
                                    function: { name: call.function.name, arguments: call.function.arguments }
                                }]
                            },
                            finish_reason: null
                        }]
                    });
                }
            });

            let rawContent = "";
            let rawThinking = "";
            let openTagCount = 0;
            let buffer = "";
            let upstreamFinishReason = null;
            const decoder = new TextDecoder("utf-8");
            const processSseBlock = (block) => {
                const lines = String(block || "").split(/\r?\n/).filter((l) => l.startsWith("data:"));
                for (const line of lines) {
                    const payloadStr = line.slice(5).trim();
                    if (!payloadStr || payloadStr === "[DONE]") continue;
                    const parsedPayload = tryParseJson(payloadStr);
                    if (!parsedPayload.ok) continue;

                    const payload = parsedPayload.value;
                    if (payload.model) model = payload.model;
                    if (payload.created) created = payload.created;
                    if (payload.usage) upstreamUsage = payload.usage;
                    const choice = Array.isArray(payload.choices) ? payload.choices[0] : null;
                    if (!choice) continue;
                    if (choice.finish_reason != null) upstreamFinishReason = choice.finish_reason;
                    const delta = choice.delta || {};

                    if (delta.reasoning || delta.reasoning_content) {
                        rawThinking += (delta.reasoning || delta.reasoning_content);
                        writeSse({
                            id, object: "chat.completion.chunk", created, model,
                            choices: [{ index: 0, delta: { reasoning: delta.reasoning || delta.reasoning_content }, finish_reason: null }]
                        });
                    }

                    if (delta.content) {
                        rawContent += delta.content;
                        if (bridgeMeta.protocol === "xml") {
                            const openMatches = delta.content.match(/<open>/g);
                            if (openMatches) openTagCount += openMatches.length;
                        }
                        parser.feed(delta.content);
                    }
                }
            };

            for await (const chunk of activeResponse.body) {
                const textChunk = decoder.decode(chunk, { stream: true });
                buffer += textChunk;
                const parts = buffer.split(/\n\n+/);
                buffer = parts.pop();
                for (const block of parts) processSseBlock(block);
            }
            if (buffer.trim()) processSseBlock(buffer);

            parser.flush();
            flushStripBuf();
            const bridgeResult = buildBridgeResultFromText(rawContent, rawThinking, bridgeMeta.normalizedTools);

            if (rawThinking) {
                log(`--- THINKING (${rawThinking.length} chars) ---`);
                log(rawThinking.length > 500 ? rawThinking.substring(0, 500) + "\n... [truncated]" : rawThinking);
                log("");
            }
            log(`--- CONTENT (${rawContent.length} chars) | <open> tags: ${openTagCount} ---`);
            log(rawContent || "(empty)");
            log("");
            if (parser.completedCalls.length > 0) {
                log(`--- TOOL CALLS: ${parser.completedCalls.length} ---`);
                for (const tc of parser.completedCalls) {
                    const args = tc.function?.arguments || "";
                    const preview = args.length > 200 ? args.substring(0, 200) + "..." : args;
                    log(`  [${tc.function?.name}] id=${tc.id} args=${preview}`);
                }
                log("");
            } else {
                log("--- NO TOOL CALLS ---\n");
            }
            log(`--- UPSTREAM FINISH REASON ---`);
            log(String(upstreamFinishReason ?? "(none)"));
            log("");

            const recoveredCalls = bridgeResult.kind === "tool_calls" && Array.isArray(bridgeResult.message?.tool_calls)
                ? bridgeResult.message.tool_calls
                : [];

            if (bridgeResult.kind !== "invalid") {
                if (bridgeMeta.protocol === "object" && !parser.messageEmitted && bridgeResult.message?.content) {
                    emitContent(bridgeResult.message.content);
                }
                if (bridgeMeta.protocol === "object" && recoveredCalls.length > parser.completedCalls.length) {
                    for (const [offset, call] of recoveredCalls.slice(parser.completedCalls.length).entries()) {
                        flushStripBuf();
                        writeSse({
                            id, object: "chat.completion.chunk", created, model,
                            choices: [{
                                index: 0,
                                delta: {
                                    tool_calls: [{
                                        index: parser.completedCalls.length + offset,
                                        id: call.id,
                                        type: "function",
                                        function: { name: call.function.name, arguments: call.function.arguments }
                                    }]
                                },
                                finish_reason: null
                            }]
                        });
                    }
                }
            }

            if (bridgeResult.kind === "invalid") {
                const notice = `[NanoProxy] Invalid bridged completion: upstream returned no visible content or tool call for a tool-enabled turn${upstreamFinishReason ? ` (finish_reason=${upstreamFinishReason})` : ""}.`;
                if (parser.toolIndex === 0 && attempt === 0) {
                    log(`--- INVALID BRIDGE COMPLETION ---`);
                    log(`${notice} Retrying once.`);
                    log("");
                    activeResponse = await fetchUpstream(req, upstreamUrl, retryBuffer);
                    activeContentType = activeResponse.headers.get("content-type") || "";
                    continue;
                }
                if (parser.toolIndex === 0) {
                    log(`--- INVALID BRIDGE COMPLETION ---`);
                    log(notice);
                    log("");
                    invalidNotice = notice;
                }
            }

            finalToolIndex = recoveredCalls.length || parser.toolIndex;
            finalFinishReason = recoveredCalls.length > 0 ? "tool_calls" : (upstreamFinishReason || "stop");
            break;
        }

        if (invalidNotice) emitContent(invalidNotice);

        writeSse({
            id, object: "chat.completion.chunk", created, model,
            choices: [{ index: 0, delta: {}, finish_reason: finalFinishReason || "stop" }],
            ...(upstreamUsage ? { usage: upstreamUsage } : {})
        });
        res.write("data: [DONE]\n\n");
        clearInterval(heartbeatTimer);
        res.end();
        logRequestSummary({ reqNum, method: req.method, url: req.url, status: 200, model, bridgeMode: `bridge:${bridgeMeta.protocol}`, toolCount: finalToolIndex, usage: upstreamUsage, finishReason: finalFinishReason });
        return;
    }

    if (bridgeMeta && upstreamResponse.ok && contentType.includes("application/json")) {
        const retryBuffer = buildInvalidBridgeRetryBuffer(bridgeMeta.rewritten, bridgeMeta.protocol);
        let activeResponse = upstreamResponse;
        for (let attempt = 0; attempt < 2; attempt++) {
            const upstreamText = await activeResponse.text();
            const upstreamJson = tryParseJson(upstreamText);
            if (!upstreamJson.ok) break;

            const aggregate = buildAggregateFromChatCompletion(upstreamJson.value);
            const bridgeResult = buildBridgeResultFromText(aggregate.content, aggregate.reasoning, bridgeMeta.normalizedTools);
            if (bridgeResult.kind === "invalid" && attempt === 0) {
                logSection("RAW MODEL OUTPUT", aggregate.content);
                logSection("INVALID BRIDGE COMPLETION", { retrying: true, upstream_finish_reason: aggregate.finishReason });
                activeResponse = await fetchUpstream(req, upstreamUrl, retryBuffer);
                continue;
            }
            if (bridgeResult.kind === "invalid") {
                const errorPayload = { error: { code: bridgeResult.error.code, message: bridgeResult.error.message, upstream_finish_reason: aggregate.finishReason } };
                logSection("RAW MODEL OUTPUT", aggregate.content);
                logSection("INVALID BRIDGE COMPLETION", errorPayload);
                const buf = Buffer.from(JSON.stringify(errorPayload), "utf8");
                res.writeHead(502, { "content-type": "application/json; charset=utf-8", "content-length": String(buf.length) });
                res.end(buf);
                logRequestSummary({ reqNum, method: req.method, url: req.url, status: 502, model: aggregate?.model, bridgeMode: `bridge:${bridgeMeta?.protocol}`, usage: aggregate?.usage, finishReason: "error" });
                return;
            }

            const translated = buildChatCompletionFromBridge(aggregate, bridgeMeta.normalizedTools);
            logSection("RAW MODEL OUTPUT", aggregate.content);
            logSection("TRANSLATED RESPONSE", translated);
            const buf = Buffer.from(JSON.stringify(translated), "utf8");
            compressIfPossible(req, res, buf, "application/json; charset=utf-8");
            logRequestSummary({ reqNum, method: req.method, url: req.url, status: 200, model: aggregate.model, bridgeMode: `bridge:${bridgeMeta.protocol}`, toolCount: bridgeResult.kind === "tool_calls" ? bridgeResult.message.tool_calls.length : 0, usage: aggregate.usage, cost: upstreamJson.value?.x_nanogpt_pricing?.amount, finishReason: bridgeResult.finishReason });
            return;
        }
    }

    if (contentType.includes("text/event-stream")) {
        res.writeHead(upstreamResponse.status, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache, no-transform",
            connection: "keep-alive"
        });
        for await (const chunk of upstreamResponse.body) res.write(chunk);
        res.end();
        logRequestSummary({ reqNum, method: req.method, url: req.url, status: upstreamResponse.status, bridgeMode: "passthrough" });
        return;
    }

    const rawBuffer = Buffer.from(await upstreamResponse.arrayBuffer());
    copyResponseHeaders(upstreamResponse.headers, res);
    if (clientAcceptsGzip(req) && rawBuffer.length > 256) {
        const compressed = zlib.gzipSync(rawBuffer);
        res.setHeader("content-encoding", "gzip");
        res.setHeader("content-length", String(compressed.length));
        res.writeHead(upstreamResponse.status);
        res.end(compressed);
    } else {
        res.setHeader("content-length", String(rawBuffer.length));
        res.writeHead(upstreamResponse.status);
        res.end(rawBuffer);
    }
    logRequestSummary({ reqNum, method: req.method, url: req.url, status: upstreamResponse.status, bridgeMode: "passthrough" });
}

function startServer() {
    const server = http.createServer((req, res) => {
        proxyRequest(req, res).catch((error) => {
            log(`--- ERROR ---\n${error && error.stack ? error.stack : error}\n`);
            console.error("[NanoProxy Error]", error);
            if (!res.headersSent) {
                res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
                res.end(JSON.stringify({ error: { message: String(error && error.message ? error.message : error) } }));
            } else {
                res.end();
            }
        });
    });

    server.listen(LISTEN_PORT, LISTEN_HOST, () => {
        console.log(`NanoProxy listening on http://${LISTEN_HOST}:${LISTEN_PORT}`);
        if (ENABLE_DEBUG_LOGS && SESSION_LOG) console.log(`Session log: ${SESSION_LOG}`);
    });
    return server;
}

if (require.main === module) {
    startServer();
}

module.exports = {
    startServer,
    ...core
};
