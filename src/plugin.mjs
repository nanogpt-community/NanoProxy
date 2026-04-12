import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { fileURLToPath, pathToFileURL } from "node:url"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const DEBUG_FLAG_FILE = join(process.cwd(), ".debug-logging")
const FETCH_PATCH_KEY = Symbol.for("nanoproxy.fetchPatch")

export const NanoProxyPlugin = async function NanoProxyPlugin() {
  if (globalThis[FETCH_PATCH_KEY]?.installed) return {}
  let imported
  try {
    imported = await import(pathToFileURL(join(__dirname, "core.js")).href)
  } catch {
    return {}
  }

  const core = imported?.default && typeof imported.default === "object"
    ? { ...imported.default, ...imported }
    : imported

  if (!core || typeof core !== "object") return {}

  const {
    tryParseJson,
    requestNeedsBridge,
    requestNeedsXmlBridge,
    transformRequestForBridge,
    buildAggregateFromChatCompletion,
    buildChatCompletionFromBridge,
    buildBridgeResultFromText,
    acceptNativeJson,
    acceptNativeSSE,
    sseLine,
    createStreamingBridgeParser
  } = core

  if (typeof tryParseJson !== "function" || typeof transformRequestForBridge !== "function") return {}

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
    try { mkdirSync(LOG_DIR, { recursive: true }) } catch {}
    if (RAW_DEBUG) {
      try { mkdirSync(RAW_LOG_DIR, { recursive: true }) } catch {}
    }
  }

  function log(text) {
    if (!VERBOSE || !SESSION_LOG) return
    try {
      appendFileSync(SESSION_LOG, String(text) + "\n")
    } catch {}
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
    } catch {}
  }

  function appendRawDebugFile(name, content, force = false) {
    if ((!RAW_DEBUG && !force) || !VERBOSE) return
    try {
      mkdirSync(RAW_LOG_DIR, { recursive: true })
      appendFileSync(join(RAW_LOG_DIR, name), content)
    } catch {}
  }

  function writeRawDebugJson(name, value, force = false) {
    writeRawDebugFile(name, JSON.stringify(value, null, 2), force)
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
    const retryBody = JSON.parse(JSON.stringify(rewrittenBody))
    retryBody.messages = Array.isArray(retryBody.messages) ? retryBody.messages.slice() : []
    const content = protocol === "object"
      ? "Your previous response was invalid because it contained no visible content or tool call. Return exactly one valid JSON turn object that matches the required bridge contract. Do not return an empty response."
      : "Your previous response was invalid because it contained no visible content and no XML tool call. Do not return an empty response. If you need to act, emit the XML tool call now. If no tool is needed, provide a normal visible reply."
    retryBody.messages.push({ role: "system", content })
    return new TextEncoder().encode(JSON.stringify(retryBody))
  }

  async function processStreamingResponse(response, dbgData, transformed, urlStr, init, originalFetch, requestHeaders) {
    let reader = response.body.getReader()
    const decoder = new TextDecoder()
    const encoder = new TextEncoder()
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
      } catch {}
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

    ;(async () => {
      let finalFinishReason = "stop"
      let finalToolIndex = 0
      let invalidNotice = null

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
              const retryResponse = await originalFetch(urlStr, {
                ...init,
                method: "POST",
                headers: retryHeaders,
                body: retryBody
              })
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
          choices: [{ index: 0, delta: {}, finish_reason: finalFinishReason }]
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
        try { await writer.abort(error) } catch {}
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

  const originalFetch = globalThis[FETCH_PATCH_KEY]?.originalFetch || globalThis.fetch
  globalThis[FETCH_PATCH_KEY] = { installed: true, originalFetch }
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

    const clonedRequest = input instanceof Request ? input.clone() : null
    let bodyText
    try {
      if (clonedRequest) bodyText = await clonedRequest.text()
      else if (typeof init?.body === "string") bodyText = init.body
      else if (init?.body instanceof ArrayBuffer || ArrayBuffer.isView(init?.body)) bodyText = new TextDecoder().decode(init.body)
      else if (init?.body != null && typeof init.body.text === "function") bodyText = await init.body.text()
      else return originalFetch(input, init, ...rest)
    } catch {
      return originalFetch(input, init, ...rest)
    }

    const parsed = tryParseJson(bodyText)
    if (!parsed.ok || !requestNeedsXmlBridge(parsed.value)) return originalFetch(input, init, ...rest)

    const shouldBridgeImmediately = requestNeedsBridge(parsed.value)
    if (!shouldBridgeImmediately) {
      log(`--- NATIVE-FIRST ATTEMPT | request=${requestId} | model=${parsed.value.model || "(unknown)"} ---`)
      log("")
      const nativeResponse = await originalFetch(input, init, ...rest)
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

    const transformed = transformRequestForBridge(parsed.value)
    log(`--- BRIDGE ACTIVE | protocol=${transformed.protocol} | tools=[${transformed.toolNames.join(", ")}] ---`)
    log("")
    writeRawDebugJson(`${requestId}-request.json`, {
      requestId,
      url: urlStr,
      requestBodyOriginal: parsed.value,
      requestBodyRewritten: transformed.rewritten,
      bridgeApplied: transformed.bridgeApplied
    })

    const newBodyBytes = new TextEncoder().encode(JSON.stringify(transformed.rewritten))
    const headers = new Headers(input instanceof Request ? input.headers : {})
    if (init?.headers) {
      const initHeaders = new Headers(init.headers)
      for (const [k, v] of initHeaders) headers.set(k, v)
    }
    headers.set("content-type", "application/json")
    headers.set("content-length", String(newBodyBytes.length))

    const response = await originalFetch(urlStr, {
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
        const retryResponse = await originalFetch(urlStr, {
          ...init,
          method: "POST",
          headers: retryHeaders,
          body: retryBody
        })
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

  return {}
}

export default NanoProxyPlugin





