import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { fileURLToPath, pathToFileURL } from "node:url"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const DEBUG_FLAG_FILE = join(process.cwd(), ".debug-logging")
const _encoder = new TextEncoder()
const _decoder = new TextDecoder()

const FETCH_PATCH_KEY = Symbol.for("nanoproxy.fetchPatch")
const ORIGINAL_FETCH_KEY = Symbol.for("nanoproxy.originalFetch")
const MAX_BODY_BYTES = Number(process.env.NANOPROXY_MAX_BODY_BYTES || 20 * 1024 * 1024)
const UPSTREAM_TIMEOUT_MS = Number(process.env.NANOPROXY_UPSTREAM_TIMEOUT_MS || 120000)

function uninstallFetchPatch() {
    const original = globalThis[ORIGINAL_FETCH_KEY]
    if (original && globalThis.fetch !== original) globalThis.fetch = original
    delete globalThis[FETCH_PATCH_KEY]
}

function createPluginHooks(client) {
    let announced = false
    return {
        event: async () => {
            if (announced) return
            announced = true
            try {
                await client?.app?.log?.({
                    body: {
                        service: "nanogpt-nanoproxy",
                        level: "info",
                        message: "NanoProxy plugin initialized"
                    }
                })
            } catch { }
        }
    }
}

export const NanoProxyPlugin = async function NanoProxyPlugin(ctx = {}) {
    const hooks = createPluginHooks(ctx?.client)
    if (globalThis[FETCH_PATCH_KEY]?.installed) return hooks
    let imported
    try {
        imported = await import(pathToFileURL(join(__dirname, "core.js")).href)
    } catch {
        return hooks
    }

    const core = imported?.default && typeof imported.default === "object"
        ? { ...imported.default, ...imported }
        : imported

    if (!core || typeof core !== "object") return hooks

    const {
        tryParseJson,
        requestNeedsBridge,
        requestNeedsXmlBridge,
        withOptionalIncludeUsage,
        transformRequestForBridge,
        buildAggregateFromChatCompletion,
        buildChatCompletionFromBridge,
        buildBridgeResultFromText,
        acceptNativeJson,
        acceptNativeSSE,
        sseLine,
        createStreamingBridgeParser
    } = core

    if (typeof tryParseJson !== "function" || typeof transformRequestForBridge !== "function") return hooks

    const LOG_DIR = process.env.NANOPROXY_LOG_DIR || join(tmpdir(), "nanoproxy-plugin-logs")
    const VERBOSE =
        process.env.NANOPROXY_DEBUG === "1" ||
        process.env.NANOPROXY_DEBUG === "true" ||
        existsSync(DEBUG_FLAG_FILE)
    const RAW_DEBUG =
        process.env.NANOPROXY_RAW_LOGS === "1" ||
        process.env.NANOPROXY_RAW_LOGS === "true"
    const RAW_LOG_DIR = join(LOG_DIR, "raw")
    const SESSION_START = new Date().toISOString().replace(/[:.]/g, "-")
    const SESSION_LOG = VERBOSE ? join(LOG_DIR, `session-${SESSION_START}.log`) : null
    let requestCounter = 0

    if (VERBOSE) {
        try { mkdirSync(LOG_DIR, { recursive: true }) } catch { }
        if (RAW_DEBUG) {
            try { mkdirSync(RAW_LOG_DIR, { recursive: true }) } catch { }
        }
    }

    let _logPending = []
    let _logTimer = null
    const _LOG_FLUSH_MS = 250
    function _scheduleLogFlush() {
        if (_logTimer || _logPending.length === 0) return
        _logTimer = setInterval(() => {
            if (_logPending.length === 0) {
                clearInterval(_logTimer)
                _logTimer = null
                return
            }
            const chunk = _logPending.join("")
            _logPending = []
            try { appendFileSync(SESSION_LOG, chunk) } catch { }
        }, _LOG_FLUSH_MS)
        if (typeof _logTimer.unref === "function") _logTimer.unref()
    }

    function log(text) {
        if (!VERBOSE || !SESSION_LOG) return
        _logPending.push(String(text) + "\n")
        _scheduleLogFlush()
    }

    function flushLogs() {
        if (_logPending.length === 0) return
        const chunk = _logPending.join("")
        _logPending = []
        try { appendFileSync(SESSION_LOG, chunk) } catch { }
    }

    function logSection(title, content) {
        log(`--- ${title} ---`)
        log(typeof content === "string" ? content : JSON.stringify(content, null, 2))
        log("")
    }

    function makeRequestId() {
        return `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(16).slice(2, 10)}`
    }

    function nowStamp() {
        return new Date().toISOString().replace(/[:.]/g, "-")
    }

    function writeRawDebugFile(name, content, force = false) {
        if ((!RAW_DEBUG && !force) || !VERBOSE) return
        try {
            mkdirSync(RAW_LOG_DIR, { recursive: true })
            writeFileSync(join(RAW_LOG_DIR, name), content)
        } catch { }
    }

    function appendRawDebugFile(name, content, force = false) {
        if ((!RAW_DEBUG && !force) || !VERBOSE) return
        try {
            mkdirSync(RAW_LOG_DIR, { recursive: true })
            appendFileSync(join(RAW_LOG_DIR, name), content)
        } catch { }
    }

    function writeRawDebugJson(name, value, force = false) {
        writeRawDebugFile(name, JSON.stringify(value, null, 2), force)
    }

    function buildHeaders(input, init, bodyBytes) {
        const headers = new Headers(input instanceof Request ? input.headers : {})
        if (init?.headers) {
            const initHeaders = new Headers(init.headers)
            for (const [k, v] of initHeaders) headers.set(k, v)
        }
        headers.set("content-type", "application/json")
        headers.set("content-length", String(bodyBytes.length))
        return headers
    }

    async function readBodyWithCap(input, init) {
        const clonedRequest = input instanceof Request ? input.clone() : null
        if (clonedRequest) {
            const declaredLength = Number(clonedRequest.headers.get("content-length"))
            if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
                return { tooLarge: true, body: null }
            }
            const reader = clonedRequest.body && clonedRequest.body.getReader ? clonedRequest.body.getReader() : null
            if (!reader) {
                try { return { tooLarge: false, body: await clonedRequest.text() } } catch { return { tooLarge: false, body: null } }
            }
            const decoder = _decoder
            let total = 0
            let text = ""
            while (true) {
                const { done, value } = await reader.read()
                if (done) break
                total += value.byteLength
                if (total > MAX_BODY_BYTES) return { tooLarge: true, body: null }
                text += decoder.decode(value, { stream: true })
            }
            text += decoder.decode()
            return { tooLarge: false, body: text }
        }
        if (typeof init?.body === "string") {
            return { tooLarge: init.body.length > MAX_BODY_BYTES, body: init.body }
        }
        if (init?.body instanceof ArrayBuffer || ArrayBuffer.isView(init?.body)) {
            const len = init.body.byteLength ?? init.body.length ?? 0
            if (len > MAX_BODY_BYTES) return { tooLarge: true, body: null }
            return { tooLarge: false, body: _decoder.decode(init.body) }
        }
        if (init?.body != null && typeof init.body.text === "function") {
            try {
                const text = await init.body.text()
                return { tooLarge: text.length > MAX_BODY_BYTES, body: text }
            } catch { return { tooLarge: false, body: null } }
        }
        return { tooLarge: false, body: null }
    }

    async function fetchWithTimeout(target, initOptions) {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(new Error("upstream_timeout")), UPSTREAM_TIMEOUT_MS)
        if (typeof timer.unref === "function") timer.unref()
        try {
            return await originalFetch(target, { ...initOptions, signal: controller.signal })
        } finally {
            clearTimeout(timer)
        }
    }

    function sanitizeBufferedResponseHeaders(headersLike, bodyLength, contentTypeOverride) {
        const headers = new Headers(headersLike || {})
        headers.delete("content-length")
        headers.delete("content-encoding")
        headers.delete("transfer-encoding")
        if (contentTypeOverride) headers.set("content-type", contentTypeOverride)
        if (bodyLength !== undefined) headers.set("content-length", String(bodyLength))
        return headers
    }

    function buildInvalidBridgeRetryBuffer(rewrittenBody, protocol = "xml") {
        const retryBody = structuredClone(rewrittenBody)
        retryBody.messages = Array.isArray(retryBody.messages) ? retryBody.messages.slice() : []
        const systemText = retryBody.messages
            .filter((message) => message && message.role === "system")
            .map((message) => typeof message.content === "string" ? message.content : "")
            .join("\n")
        const manifestMatch = systemText.match(/Tool manifest:\n([\s\S]*?)(?:\n\nAdditional system instructions|\n*$)/)
        const manifestParsed = manifestMatch ? tryParseJson(manifestMatch[1].trim()) : { ok: false }
        const toolNames = manifestParsed.ok && Array.isArray(manifestParsed.value)
            ? manifestParsed.value.map((tool) => tool && tool.name).filter(Boolean)
            : []
        const hasAttemptCompletion = toolNames.includes("attempt_completion")
        const hasFollowup = toolNames.includes("ask_followup_question")
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
            ].filter(Boolean).join("\n")
        retryBody.messages.push({ role: "system", content })
        return _encoder.encode(JSON.stringify(retryBody))
    }

    async function processStreamingResponse(response, dbgData, transformed, urlStr, init, originalFetch, requestHeaders) {
        let reader = response.body.getReader()
        const decoder = _decoder
        const encoder = _encoder
        const rawSseFile = `${dbgData.requestId}-stream.sse`

        const { readable, writable } = new TransformStream()
        const writer = writable.getWriter()
        const SSE_HEARTBEAT_INTERVAL_MS = 15000

        let streamClosed = false
        let lastDownstreamWriteAt = Date.now()
        let downstreamOps = Promise.resolve()
        const queueDownstream = (fn) => {
            downstreamOps = downstreamOps.then(fn, fn)
            return downstreamOps
        }
        const writeChunk = async (text) => {
            if (streamClosed) return
            lastDownstreamWriteAt = Date.now()
            await writer.write(encoder.encode(text))
        }

        const heartbeatTimer = setInterval(async () => {
            if (streamClosed) return
            if (Date.now() - lastDownstreamWriteAt < SSE_HEARTBEAT_INTERVAL_MS) return
            try {
                await writeChunk(": keepalive\n\n")
            } catch { }
        }, SSE_HEARTBEAT_INTERVAL_MS)
        if (typeof heartbeatTimer.unref === "function") heartbeatTimer.unref()
        const stopHeartbeat = () => {
            clearInterval(heartbeatTimer)
        }

        const STRIP_TAGS = ["<open>", "</open>"]
        let stripBuf = ""
        const emitContent = async (text) => {
            await writeChunk(sseLine({
                id: `chatcmpl_${dbgData.requestId.slice(-8)}`,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model: "nanoproxy",
                choices: [{ index: 0, delta: { content: text }, finish_reason: null }]
            }))
        }
        const feedContent = async (char) => {
            if (stripBuf.length > 0) {
                stripBuf += char
                let couldMatch = false
                let exactMatch = false
                for (const tag of STRIP_TAGS) {
                    if (tag.startsWith(stripBuf)) couldMatch = true
                    if (tag === stripBuf) exactMatch = true
                }
                if (exactMatch) stripBuf = ""
                else if (!couldMatch) {
                    for (const c of stripBuf) await emitContent(c)
                    stripBuf = ""
                }
            } else if (char === "<") {
                stripBuf = "<"
            } else {
                await emitContent(char)
            }
        }
        const flushStripBuf = async () => {
            if (!stripBuf.length) return
            if (!STRIP_TAGS.includes(stripBuf)) {
                for (const c of stripBuf) await emitContent(c)
            }
            stripBuf = ""
        }

            ; (async () => {
                let finalFinishReason = "stop"
                let finalToolIndex = 0
                let invalidNotice = null
                let upstreamUsage = null

                try {
                    await writeChunk(sseLine({
                        id: `chatcmpl_${dbgData.requestId.slice(-8)}`,
                        object: "chat.completion.chunk",
                        created: Math.floor(Date.now() / 1000),
                        model: "nanoproxy",
                        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }]
                    }))

                    for (let attempt = 0; attempt < 2; attempt++) {
                        if (attempt > 0) {
                            log(`--- RETRY INVALID EMPTY | request=${dbgData.requestId} | attempt=${attempt + 1} ---`)
                            log("")
                        }

                        const parser = createStreamingBridgeParser(transformed.normalizedTools, {
                            onContent: (text) => {
                                queueDownstream(async () => {
                                    if (transformed.protocol === "object") await emitContent(text)
                                    else for (const c of text) await feedContent(c)
                                })
                            },
                            onToolCall: (call, index) => {
                                queueDownstream(async () => {
                                    await flushStripBuf()
                                    await writeChunk(sseLine({
                                        id: `chatcmpl_${dbgData.requestId.slice(-8)}`,
                                        object: "chat.completion.chunk",
                                        created: Math.floor(Date.now() / 1000),
                                        model: "nanoproxy",
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
                                    }))
                                })
                            }
                        })

                        let rawContent = ""
                        let rawThinking = ""
                        let openTagCount = 0
                        let buffer = ""
                        let upstreamFinishReason = null

                        const processSseBlock = async (block) => {
                            const lines = String(block || "").split(/\r?\n/).filter((l) => l.startsWith("data:"))
                            for (const line of lines) {
                                const payloadStr = line.slice(5).trim()
                                if (!payloadStr || payloadStr === "[DONE]") continue
                                const parsed = tryParseJson(payloadStr)
                                if (!parsed.ok) continue
                                const payload = parsed.value
                                if (payload.usage) upstreamUsage = payload.usage
                                const choice = Array.isArray(payload.choices) ? payload.choices[0] : null
                                if (!choice) continue
                                if (choice.finish_reason != null) upstreamFinishReason = choice.finish_reason
                                const delta = choice.delta || {}
                                if (delta.reasoning || delta.reasoning_content) {
                                    const text = delta.reasoning || delta.reasoning_content
                                    rawThinking += text
                                    await writeChunk(sseLine({
                                        id: payload.id || `chatcmpl_${dbgData.requestId.slice(-8)}`,
                                        object: "chat.completion.chunk",
                                        created: payload.created || Math.floor(Date.now() / 1000),
                                        model: payload.model || "nanoproxy",
                                        choices: [{ index: 0, delta: { reasoning: text }, finish_reason: null }]
                                    }))
                                }
                                if (delta.content) {
                                    rawContent += delta.content
                                    if (transformed.protocol === "xml") {
                                        const openMatches = delta.content.match(/<open>/g)
                                        if (openMatches) openTagCount += openMatches.length
                                    }
                                    parser.feed(delta.content)
                                }
                            }
                        }

                        while (true) {
                            const { done, value } = await reader.read()
                            if (done) break
                            const textChunk = decoder.decode(value, { stream: true })
                            appendRawDebugFile(rawSseFile, textChunk)
                            buffer += textChunk
                            const parts = buffer.split(/\n\n+/)
                            buffer = parts.pop()
                            for (const block of parts) {
                                await processSseBlock(block)
                            }
                        }
                        if (buffer.trim()) await processSseBlock(buffer)

                        parser.flush()
                        await downstreamOps
                        await flushStripBuf()

                        const bridgeResult = buildBridgeResultFromText(rawContent, rawThinking, transformed.normalizedTools)
                        log(`--- STREAM BRIDGE RESULT | request=${dbgData.requestId} | kind=${bridgeResult.kind} | finish_reason=${upstreamFinishReason || "(none)"} | tool_calls=${parser.completedCalls.length} ---`)
                        if (rawThinking) logSection(`THINKING (${rawThinking.length} chars)`, rawThinking)
                        if (rawContent) logSection(`CONTENT (${rawContent.length} chars)${transformed.protocol === "xml" ? ` | <open> tags: ${openTagCount}` : ""}`, rawContent)
                        if (parser.completedCalls.length) {
                            logSection("TOOL CALLS", parser.completedCalls.map((call, index) => ({
                                index,
                                id: call.id,
                                name: call.function?.name,
                                arguments: call.function?.arguments
                            })))
                        } else {
                            log("--- NO TOOL CALLS ---")
                            log("")
                        }
                        writeRawDebugJson(`${dbgData.requestId}-response.json`, { rawContent, rawThinking, bridgeResult, upstreamFinishReason })

                        const recoveredCalls = bridgeResult.kind === "tool_calls" && Array.isArray(bridgeResult.message?.tool_calls)
                            ? bridgeResult.message.tool_calls
                            : []

                        if (bridgeResult.kind !== "invalid") {
                            if (transformed.protocol === "object" && !parser.messageEmitted && bridgeResult.message?.content) {
                                await emitContent(bridgeResult.message.content)
                            }
                            if (transformed.protocol === "object" && recoveredCalls.length > parser.completedCalls.length) {
                                for (const [offset, call] of recoveredCalls.slice(parser.completedCalls.length).entries()) {
                                    await flushStripBuf()
                                    await writeChunk(sseLine({
                                        id: `chatcmpl_${dbgData.requestId.slice(-8)}`,
                                        object: "chat.completion.chunk",
                                        created: Math.floor(Date.now() / 1000),
                                        model: "nanoproxy",
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
                                    }))
                                }
                            }
                        }

                        if (bridgeResult.kind === "invalid") {
                            if (parser.toolIndex === 0 && attempt === 0) {
                                const retryBody = buildInvalidBridgeRetryBuffer(transformed.rewritten, transformed.protocol)
                                const retryHeaders = new Headers(requestHeaders)
                                retryHeaders.set("content-length", String(retryBody.length))
                                const retryResponse = await fetchWithTimeout(urlStr, {
                                    ...init,
                                    method: "POST",
                                    headers: retryHeaders,
                                    body: retryBody
                                })
                                if (!retryResponse.ok || !retryResponse.body) {
                                    invalidNotice = `[NanoProxy] Retry failed: upstream returned status ${retryResponse.status}.`
                                    break
                                }
                                reader = retryResponse.body.getReader()
                                appendRawDebugFile(rawSseFile, "\n# retry=invalid_empty\n")
                                continue
                            }
                            if (parser.toolIndex === 0) {
                                invalidNotice = `[NanoProxy] Invalid bridged completion: upstream returned no visible content or tool call for a tool-enabled turn${upstreamFinishReason ? ` (finish_reason=${upstreamFinishReason})` : ""}.`
                                writeRawDebugJson(`${dbgData.requestId}-response.json`, { rawContent, rawThinking, bridgeResult, upstreamFinishReason, invalidNotice }, true)
                            }
                        }

                        finalToolIndex = recoveredCalls.length || parser.toolIndex
                        finalFinishReason = recoveredCalls.length > 0 ? "tool_calls" : (upstreamFinishReason || "stop")
                        break
                    }

                    await downstreamOps
                    if (invalidNotice) await emitContent(invalidNotice)

                    await writeChunk(sseLine({
                        id: `chatcmpl_${dbgData.requestId.slice(-8)}`,
                        object: "chat.completion.chunk",
                        created: Math.floor(Date.now() / 1000),
                        model: "nanoproxy",
                        choices: [{ index: 0, delta: {}, finish_reason: finalFinishReason }],
                        ...(upstreamUsage ? { usage: upstreamUsage } : {})
                    }))
                    await writeChunk("data: [DONE]\n\n")
                    streamClosed = true
                    await writer.close()
                    log(`--- STREAM DONE | request=${dbgData.requestId} | tool_calls=${finalToolIndex} | finish_reason=${finalFinishReason} ---`)
                    log("")
                } catch (error) {
                    log(`--- STREAM ERROR | request=${dbgData.requestId} ---`)
                    log(error?.stack || error?.message || String(error))
                    log("")
                    streamClosed = true
                    try { await writer.abort(error) } catch { }
                }
            })()

        return new Response(readable, {
            status: response.status,
            headers: {
                "content-type": "text/event-stream; charset=utf-8",
                "cache-control": "no-cache"
            }
        })
    }

    if (!globalThis[ORIGINAL_FETCH_KEY]) {
        globalThis[ORIGINAL_FETCH_KEY] = globalThis[FETCH_PATCH_KEY]?.originalFetch || globalThis.fetch
    }
    const originalFetch = globalThis[ORIGINAL_FETCH_KEY]
    globalThis[FETCH_PATCH_KEY] = { installed: true, originalFetch, uninstall: uninstallFetchPatch }
    log("")
    log(`${"=".repeat(80)}`)
    log(`PLUGIN SESSION | ${new Date().toISOString()} | pid=${process.pid}`)
    log(`${"=".repeat(80)}`)
    log(`mode=${process.env.BRIDGE_PROTOCOL || "object"} | verbose=${VERBOSE} | raw_debug=${RAW_DEBUG}`)
    log("")

    globalThis.fetch = async function nanoproxyFetch(input, init, ...rest) {
        const urlStr = input instanceof Request ? input.url : String(input)
        if (!urlStr.includes("nano-gpt.com")) return originalFetch(input, init, ...rest)

        const requestId = makeRequestId()
        requestCounter++
        const reqNum = requestCounter
        const method = String(init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase()
        log(`${"=".repeat(80)}`)
        log(`REQUEST #${reqNum} | ${new Date().toISOString()} | ${method} ${urlStr}`)
        log(`${"=".repeat(80)}`)
        if (method !== "POST") return originalFetch(input, init, ...rest)

        const readResult = await readBodyWithCap(input, init)
        if (readResult.tooLarge) {
            log(`--- BODY TOO LARGE | request=${requestId} | limit=${MAX_BODY_BYTES} ---\n`)
            return new Response(JSON.stringify({ error: { code: "body_too_large", message: `Request body exceeds ${MAX_BODY_BYTES} bytes.` } }), {
                status: 413,
                headers: { "content-type": "application/json" }
            })
        }
        if (readResult.body == null) return originalFetch(input, init, ...rest)
        const bodyText = readResult.body

        const parsed = tryParseJson(bodyText)
        if (!parsed.ok) return originalFetch(input, init, ...rest)
        const requestBody = withOptionalIncludeUsage(parsed.value)
        if (!requestNeedsXmlBridge(requestBody)) {
            const passthroughBodyText = JSON.stringify(requestBody)
            const passthroughBodyBytes = _encoder.encode(passthroughBodyText)
            const passthroughHeaders = buildHeaders(input, init, passthroughBodyBytes)
            return fetchWithTimeout(urlStr, {
                ...init,
                method: "POST",
                headers: passthroughHeaders,
                body: passthroughBodyBytes,
            })
        }

        const shouldBridgeImmediately = requestNeedsBridge(requestBody)
        if (!shouldBridgeImmediately) {
            log(`--- NATIVE-FIRST ATTEMPT | request=${requestId} | model=${requestBody.model || "(unknown)"} ---`)
            log("")
            const nativeBodyText = JSON.stringify(requestBody)
            const nativeBodyBytes = _encoder.encode(nativeBodyText)
            const nativeHeaders = buildHeaders(input, init, nativeBodyBytes)
            const nativeResponse = await fetchWithTimeout(urlStr, {
                ...init,
                method: "POST",
                headers: nativeHeaders,
                body: nativeBodyBytes,
            })
            const nativeContentType = nativeResponse.headers.get("content-type") ?? ""
            if (nativeContentType.includes("text/event-stream")) {
                const streamText = await nativeResponse.text()
                if (acceptNativeSSE(nativeResponse.status, streamText)) {
                    log(`--- NATIVE-FIRST RESULT | request=${requestId} | accepted=true | type=sse ---`)
                    log("")
                    return new Response(streamText, {
                        status: nativeResponse.status,
                        headers: sanitizeBufferedResponseHeaders(nativeResponse.headers, Buffer.byteLength(streamText), "text/event-stream; charset=utf-8")
                    })
                }
            } else if (nativeContentType.includes("application/json")) {
                const jsonText = await nativeResponse.text()
                const nativeParsed = tryParseJson(jsonText)
                if (nativeParsed.ok && acceptNativeJson(nativeResponse.status, nativeParsed.value)) {
                    log(`--- NATIVE-FIRST RESULT | request=${requestId} | accepted=true | type=json ---`)
                    log("")
                    return new Response(jsonText, {
                        status: nativeResponse.status,
                        headers: sanitizeBufferedResponseHeaders(nativeResponse.headers, Buffer.byteLength(jsonText), "application/json; charset=utf-8")
                    })
                }
            } else if (nativeResponse.status >= 200 && nativeResponse.status < 300) {
                const nativeBuffer = await nativeResponse.arrayBuffer()
                log(`--- NATIVE-FIRST RESULT | request=${requestId} | accepted=true | type=other ---`)
                log("")
                return new Response(nativeBuffer, {
                    status: nativeResponse.status,
                    headers: sanitizeBufferedResponseHeaders(nativeResponse.headers, nativeBuffer.byteLength)
                })
            }
            log(`--- NATIVE-FIRST RESULT | request=${requestId} | accepted=false | fallback=bridge ---`)
            log("")
        }

        const transformed = transformRequestForBridge(requestBody)
        log(`--- BRIDGE ACTIVE | protocol=${transformed.protocol} | tools=[${transformed.toolNames.join(", ")}] ---`)
        log("")
        writeRawDebugJson(`${requestId}-request.json`, {
            requestId,
            url: urlStr,
            requestBodyOriginal: requestBody,
            requestBodyRewritten: transformed.rewritten,
            bridgeApplied: transformed.bridgeApplied
        })

        const newBodyBytes = _encoder.encode(JSON.stringify(transformed.rewritten))
        const headers = buildHeaders(input, init, newBodyBytes)

        const response = await fetchWithTimeout(urlStr, {
            ...init,
            method: "POST",
            headers,
            body: newBodyBytes,
        })

        const contentType = response.headers.get("content-type") ?? ""
        const dbgData = { requestId, url: urlStr, status: response.status, contentType }
        log(`--- BRIDGE RESPONSE | request=${requestId} | status=${response.status} | content_type=${contentType || "(none)"} ---`)
        log("")

        if (!response.ok) {
            const rawBuffer = await response.arrayBuffer()
            log(`--- PASSTHROUGH ERROR | request=${requestId} | status=${response.status} ---`)
            log("")
            return new Response(rawBuffer, {
                status: response.status,
                headers: sanitizeBufferedResponseHeaders(response.headers, rawBuffer.byteLength)
            })
        }

        if (contentType.includes("text/event-stream")) {
            return processStreamingResponse(response, dbgData, transformed, urlStr, init, originalFetch, headers)
        }

        const responseText = await response.text()
        const responseParsed = tryParseJson(responseText)
        if (responseParsed.ok) {
            const v = responseParsed.value
            const aggregate = buildAggregateFromChatCompletion(v)
            const bridgeResult = buildBridgeResultFromText(aggregate.content, aggregate.reasoning, transformed.normalizedTools)
            if (bridgeResult.kind === "invalid") {
                log(`--- JSON RETRY INVALID EMPTY | request=${requestId} ---`)
                log("")
                const retryBody = buildInvalidBridgeRetryBuffer(transformed.rewritten, transformed.protocol)
                const retryHeaders = new Headers(headers)
                retryHeaders.set("content-length", String(retryBody.length))
                const retryResponse = await fetchWithTimeout(urlStr, {
                    ...init,
                    method: "POST",
                    headers: retryHeaders,
                    body: retryBody
                })
                if (!retryResponse.ok) {
                    const errBuf = await retryResponse.arrayBuffer()
                    return new Response(errBuf, {
                        status: retryResponse.status,
                        headers: sanitizeBufferedResponseHeaders(retryResponse.headers, errBuf.byteLength)
                    })
                }
                const retryText = await retryResponse.text()
                const retryParsed = tryParseJson(retryText)
                if (retryParsed.ok) {
                    const retryAggregate = buildAggregateFromChatCompletion(retryParsed.value)
                    const bridged = buildChatCompletionFromBridge(retryAggregate, transformed.normalizedTools)
                    log(`--- JSON BRIDGE RESULT | request=${requestId} | retried=true ---`)
                    if (retryAggregate.reasoning) logSection(`THINKING (${retryAggregate.reasoning.length} chars)`, retryAggregate.reasoning)
                    if (retryAggregate.content) logSection(`CONTENT (${retryAggregate.content.length} chars)`, retryAggregate.content)
                    if (Array.isArray(bridged?.choices?.[0]?.message?.tool_calls) && bridged.choices[0].message.tool_calls.length) {
                        logSection("TOOL CALLS", bridged.choices[0].message.tool_calls.map((call, index) => ({
                            index,
                            id: call.id,
                            name: call.function?.name,
                            arguments: call.function?.arguments
                        })))
                    } else {
                        log("--- NO TOOL CALLS ---")
                        log("")
                    }
                    writeRawDebugJson(`${requestId}-response.json`, { requestId, upstreamResponse: retryParsed.value, rewrittenResponse: bridged, retried: true }, true)
                    return new Response(JSON.stringify(bridged), { status: retryResponse.status, headers: { "content-type": "application/json" } })
                }
            }
            const bridged = buildChatCompletionFromBridge(aggregate, transformed.normalizedTools)
            log(`--- JSON BRIDGE RESULT | request=${requestId} | retried=false ---`)
            if (aggregate.reasoning) logSection(`THINKING (${aggregate.reasoning.length} chars)`, aggregate.reasoning)
            if (aggregate.content) logSection(`CONTENT (${aggregate.content.length} chars)`, aggregate.content)
            if (Array.isArray(bridged?.choices?.[0]?.message?.tool_calls) && bridged.choices[0].message.tool_calls.length) {
                logSection("TOOL CALLS", bridged.choices[0].message.tool_calls.map((call, index) => ({
                    index,
                    id: call.id,
                    name: call.function?.name,
                    arguments: call.function?.arguments
                })))
            } else {
                log("--- NO TOOL CALLS ---")
                log("")
            }
            writeRawDebugJson(`${requestId}-response.json`, { requestId, upstreamResponse: v, rewrittenResponse: bridged })
            return new Response(JSON.stringify(bridged), { status: response.status, headers: { "content-type": "application/json" } })
        }

        return new Response(responseText, { status: response.status, headers: response.headers })
    }

    return hooks
}

export default NanoProxyPlugin





