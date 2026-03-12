/**
 * NanoProxy OpenCode Plugin (Experimental)
 *
 * Patches globalThis.fetch to intercept NanoGPT API calls and apply the
 * tool bridge protocol transparently.
 *
 * WARNING: This is experimental. For production use, prefer the standalone
 * server mode which is more battle-tested.
 *
 * Requests with tools are rewritten to use the text-based bridge protocol,
 * and responses are converted back to native tool_calls format.
 *
 * Streaming is handled progressively - reasoning streams live, and tool
 * calls are emitted as individual deltas when complete envelopes are detected.
 */

import { appendFileSync } from "node:fs"
import { fileURLToPath, pathToFileURL } from "node:url"
import { dirname, join } from "node:path"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

export const NanoProxyPlugin = async function NanoProxyPlugin(ctx) {
  let core
  try {
    core = await import(pathToFileURL(join(__dirname, "core.js")).href)
  } catch (e) {
    return {}
  }

  if (!core || typeof core !== "object") {
    return {}
  }

  const requestNeedsBridge = core.requestNeedsBridge
  const transformRequestForBridge = core.transformRequestForBridge
  const tryParseJson = core.tryParseJson
  const buildChatCompletionFromBridge = core.buildChatCompletionFromBridge
  const buildBridgeResultFromText = core.buildBridgeResultFromText
  const generateToolCallId = core.generateToolCallId
  const applyChunkToAggregate = core.applyChunkToAggregate
  const extractProgressiveToolCalls = core.extractProgressiveToolCalls
  const extractStreamableFinalContent = core.extractStreamableFinalContent

  if (typeof requestNeedsBridge !== "function" || typeof transformRequestForBridge !== "function") {
    return {}
  }


  const LOG_FILE = process.env.NANOPROXY_LOG || "/tmp/nanoproxy-plugin.log"
  const VERBOSE = process.env.NANOPROXY_DEBUG === "1" || process.env.NANOPROXY_DEBUG === "true"

  function log(obj) {
    try {
      appendFileSync(LOG_FILE, JSON.stringify({ t: new Date().toISOString(), ...obj }) + "\n")
    } catch (e) {}
  }

  function dbg(obj) {
    if (!VERBOSE) return
    log(obj)
  }

  log({ event: "init", pid: process.pid, fetch: typeof globalThis.fetch, verbose: VERBOSE, debugEnv: process.env.NANOPROXY_DEBUG })

  const originalFetch = globalThis.fetch
  const encoder = new TextEncoder()

  function sseLine(payload) {
    return `data: ${JSON.stringify(payload)}\n\n`
  }

  async function processStreamingResponse(response, dbgData) {
    const reader = response.body.getReader()
    const decoder = new TextDecoder()

    const { readable, writable } = new TransformStream()
    const writer = writable.getWriter()

    const aggregate = {
      id: null,
      model: null,
      created: null,
      reasoning: "",
      content: "",
      finishReason: null,
      usage: undefined
    }

    let rawBuffer = ""
    let reasoningSent = 0
    let finalContentSent = 0
    let emittedToolCallCount = 0

    const flushReasoningDelta = async () => {
      if (aggregate.reasoning.length <= reasoningSent) return
      const deltaText = aggregate.reasoning.slice(reasoningSent)
      reasoningSent = aggregate.reasoning.length
      await writer.write(encoder.encode(sseLine({
        id: aggregate.id || `chatcmpl_${generateToolCallId()}`,
        object: "chat.completion.chunk",
        created: aggregate.created || Math.floor(Date.now() / 1000),
        model: aggregate.model || "tool-bridge",
        choices: [{ index: 0, delta: { reasoning: deltaText }, finish_reason: null }]
      })))
    }

    const flushFinalContentDelta = async () => {
      // Only start streaming once we've confirmed this is a final answer,
      // not a tool call. We wait until [[OPENCODE_FINAL]] appears in the buffer
      // so we never accidentally stream raw [[OPENCODE_TOOL]] envelope text.
      if (!aggregate.content.includes("OPENCODE_FINAL")) return
      const streamable = extractStreamableFinalContent(aggregate.content)
      if (!streamable || streamable.length <= finalContentSent) return
      const deltaText = streamable.slice(finalContentSent)
      finalContentSent = streamable.length
      await writer.write(encoder.encode(sseLine({
        id: aggregate.id || `chatcmpl_${generateToolCallId()}`,
        object: "chat.completion.chunk",
        created: aggregate.created || Math.floor(Date.now() / 1000),
        model: aggregate.model || "tool-bridge",
        choices: [{ index: 0, delta: { content: deltaText }, finish_reason: null }]
      })))
    }

    const flushProgressiveToolCallsFunc = async () => {
      const calls = extractProgressiveToolCalls(aggregate.content)
      if (calls.length <= emittedToolCallCount) return
      dbg({ ...dbgData, event: "stream_progressive_calls", total: calls.length, new: calls.length - emittedToolCallCount })
      for (let i = emittedToolCallCount; i < calls.length; i++) {
        const call = calls[i]
        await writer.write(encoder.encode(sseLine({
          id: aggregate.id || `chatcmpl_${generateToolCallId()}`,
          object: "chat.completion.chunk",
          created: aggregate.created || Math.floor(Date.now() / 1000),
          model: aggregate.model || "tool-bridge",
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: i,
                id: call.id,
                type: "function",
                function: { name: call.function.name, arguments: call.function.arguments }
              }]
            },
            finish_reason: null
          }]
        })))
      }
      emittedToolCallCount = calls.length
    }

    ;(async () => {
      try {
        while (true) {
          const { done, value } = await reader.read()

          if (done) {
            const result = buildBridgeResultFromText(aggregate.content, aggregate.reasoning)
            log({ ...dbgData, event: "stream_done", kind: result.kind })
            dbg({ ...dbgData, event: "stream_raw_content", content: aggregate.content, reasoning: aggregate.reasoning.slice(0, 200) })

            if (result.kind === "tool_calls") {
              const allCalls = result.message.tool_calls || []
              for (let i = emittedToolCallCount; i < allCalls.length; i++) {
                const call = allCalls[i]
                await writer.write(encoder.encode(sseLine({
                  id: aggregate.id || `chatcmpl_${generateToolCallId()}`,
                  object: "chat.completion.chunk",
                  created: aggregate.created || Math.floor(Date.now() / 1000),
                  model: aggregate.model || "tool-bridge",
                  choices: [{
                    index: 0,
                    delta: {
                      tool_calls: [{
                        index: i,
                        id: call.id,
                        type: "function",
                        function: { name: call.function.name, arguments: call.function.arguments }
                      }]
                    },
                    finish_reason: null
                  }]
                })))
              }
              await writer.write(encoder.encode(sseLine({
                id: aggregate.id || `chatcmpl_${generateToolCallId()}`,
                object: "chat.completion.chunk",
                created: aggregate.created || Math.floor(Date.now() / 1000),
                model: aggregate.model || "tool-bridge",
                choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
                ...(aggregate.usage ? { usage: aggregate.usage } : {})
              })))
            } else {
              // Flush any remaining final content not yet streamed progressively
              await flushFinalContentDelta()
              const fullFinal = extractStreamableFinalContent(aggregate.content) || result.message.content || ""
              const remaining = fullFinal.slice(finalContentSent)
              if (remaining) {
                await writer.write(encoder.encode(sseLine({
                  id: aggregate.id || `chatcmpl_${generateToolCallId()}`,
                  object: "chat.completion.chunk",
                  created: aggregate.created || Math.floor(Date.now() / 1000),
                  model: aggregate.model || "tool-bridge",
                  choices: [{ index: 0, delta: { content: remaining }, finish_reason: null }]
                })))
              }
              await writer.write(encoder.encode(sseLine({
                id: aggregate.id || `chatcmpl_${generateToolCallId()}`,
                object: "chat.completion.chunk",
                created: aggregate.created || Math.floor(Date.now() / 1000),
                model: aggregate.model || "tool-bridge",
                choices: [{ index: 0, delta: {}, finish_reason: aggregate.finishReason || "stop" }],
                ...(aggregate.usage ? { usage: aggregate.usage } : {})
              })))
            }

            await writer.write(encoder.encode("data: [DONE]\n\n"))
            await writer.close()
            break
          }

          rawBuffer += decoder.decode(value, { stream: true })
          let boundary
          while ((boundary = rawBuffer.indexOf("\n\n")) !== -1) {
            const eventText = rawBuffer.slice(0, boundary)
            rawBuffer = rawBuffer.slice(boundary + 2)
            const line = eventText
              .split(/\r?\n/)
              .map(p => p.trim())
              .find(p => p.startsWith("data:"))
            if (!line) continue
            const payload = line.slice(5).trim()
            if (!payload || payload === "[DONE]") continue
            const parsed = tryParseJson(payload)
            if (!parsed.ok) continue

            applyChunkToAggregate(aggregate, parsed.value)
            await flushReasoningDelta()
            await flushProgressiveToolCallsFunc()
            await flushFinalContentDelta()
          }
        }
      } catch (err) {
        dbg({ ...dbgData, event: "stream_error", error: err.message })
        try { await writer.abort(err) } catch (e) {}
      }
    })()

    return new Response(readable, {
      status: response.status,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
      },
    })
  }

  globalThis.fetch = async function nanoproxyFetch(input, init, ...rest) {
    const urlStr = input instanceof Request ? input.url : String(input)

    if (!urlStr.includes("nano-gpt.com")) {
      return originalFetch(input, init, ...rest)
    }

    log({ event: "intercept", url: urlStr, method: init?.method ?? "GET" })

    const method = String(
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase()
    if (method !== "POST") {
      return originalFetch(input, init, ...rest)
    }

    const clonedRequest = input instanceof Request ? input.clone() : null

    let bodyText
    try {
      if (clonedRequest) {
        bodyText = await clonedRequest.text()
      } else if (init?.body != null) {
        const b = init.body
        if (typeof b === "string") {
          bodyText = b
        } else if (b instanceof ArrayBuffer || ArrayBuffer.isView(b)) {
          bodyText = new TextDecoder().decode(b)
        } else if (typeof b.text === "function") {
          bodyText = await b.text()
        } else {
          return originalFetch(input, init, ...rest)
        }
      } else {
        return originalFetch(input, init, ...rest)
      }
    } catch (e) {
      dbg({ event: "body_read_error", url: urlStr, error: e.message })
      return originalFetch(input, init, ...rest)
    }

    const parsed = tryParseJson(bodyText)
    if (!parsed.ok || !requestNeedsBridge(parsed.value)) {
      return originalFetch(input, init, ...rest)
    }

    const transformed = transformRequestForBridge(parsed.value)
    if (!transformed.bridgeApplied) {
      log({ event: "bridge_skipped", url: urlStr, reason: "no tools or no model match" })
      return originalFetch(input, init, ...rest)
    }

    log({
      event: "bridge_request",
      url: urlStr,
      model: parsed.value.model,
      toolCount: parsed.value.tools?.length ?? 0,
    })

    const newBodyText = JSON.stringify(transformed.rewritten)
    const newBodyBytes = new TextEncoder().encode(newBodyText)

    const headers = new Headers(input instanceof Request ? input.headers : {})
    if (init?.headers) {
      const initHeaders = new Headers(init.headers)
      for (const [k, v] of initHeaders) {
        headers.set(k, v)
      }
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
    const dbgData = {
      url: urlStr,
      status: response.status,
      contentType,
    }

    dbg({ event: "bridge_response", ...dbgData })

    if (contentType.includes("text/event-stream")) {
      return processStreamingResponse(response, dbgData)
    }

    const responseText = await response.text()
    const responseParsed = tryParseJson(responseText)
    if (responseParsed.ok) {
      const v = responseParsed.value
      const choice = Array.isArray(v.choices) ? v.choices[0] : null
      const msg = choice?.message ?? {}
      const bridged = buildChatCompletionFromBridge({
        id: v.id,
        model: v.model,
        created: v.created,
        reasoning: msg.reasoning_content ?? "",
        content: msg.content ?? "",
        finishReason: choice?.finish_reason,
        usage: v.usage,
      })
      dbg({ event: "bridge_json_rewritten", finishReason: choice?.finish_reason })
      return new Response(JSON.stringify(bridged), {
        status: response.status,
        headers: { "content-type": "application/json" },
      })
    }

    dbg({ event: "bridge_passthrough", url: urlStr, reason: "response not parseable" })
    return new Response(responseText, {
      status: response.status,
      headers: response.headers,
    })
  }

  return {}
}

export default NanoProxyPlugin;
