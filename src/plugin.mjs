/**
 * NanoProxy OpenCode Plugin
 *
 * Patches globalThis.fetch to intercept NanoGPT API calls and apply the
 * tool bridge protocol transparently — no separate proxy server needed.
 * Requests with tools are rewritten to use the text-based bridge protocol,
 * and responses are converted back to native tool_calls format.
 */

import { appendFileSync } from "node:fs"

export default async function NanoProxyPlugin(ctx) {
  // Import core bridge logic from the same directory as this plugin
  let core
  try {
    core = await import(new URL('./core.js', import.meta.url))
  } catch (e) {
    // If core.js cannot be found, disable the plugin gracefully
    return {}
  }

  const {
    requestNeedsBridge,
    transformRequestForBridge,
    parseSSETranscript,
    buildSSEFromBridge,
    buildChatCompletionFromBridge,
    tryParseJson,
  } = core

  const DEBUG = process.env.NANOPROXY_DEBUG === "1" || process.env.NANOPROXY_DEBUG === "true"
  const DEBUG_LOG = "/tmp/nanoproxy-debug.log"

  function dbg(obj) {
    if (!DEBUG) return
    try {
      appendFileSync(DEBUG_LOG, JSON.stringify({ t: new Date().toISOString(), ...obj }, null, 2) + "\n---\n")
    } catch (e) {}
  }

  const originalFetch = globalThis.fetch

  async function readBodyText(input, init) {
    if (init?.body != null) {
      const b = init.body
      if (typeof b === 'string') return b
      if (b instanceof ArrayBuffer || ArrayBuffer.isView(b)) return new TextDecoder().decode(b)
      if (typeof b.text === 'function') return b.text()
    }
    if (input instanceof Request) return input.text()
    return ''
  }

  globalThis.fetch = async function nanoproxyFetch(input, init, ...rest) {
    const urlStr = input instanceof Request ? input.url : String(input)

    // Only intercept NanoGPT API calls
    if (!urlStr.includes('nano-gpt.com')) {
      return originalFetch(input, init, ...rest)
    }

    // Only intercept POST requests
    const method = String(
      init?.method ?? (input instanceof Request ? input.method : 'GET')
    ).toUpperCase()
    if (method !== 'POST') {
      return originalFetch(input, init, ...rest)
    }

    const bodyText = await readBodyText(input, init)
    const parsed = tryParseJson(bodyText)

    if (!parsed.ok || !requestNeedsBridge(parsed.value)) {
      return originalFetch(input, init, ...rest)
    }

    const transformed = transformRequestForBridge(parsed.value)
    if (!transformed.bridgeApplied) {
      dbg({ event: "bridge_skipped", url: urlStr, reason: "no tools" })
      return originalFetch(input, init, ...rest)
    }

    dbg({
      event: "bridge_request",
      url: urlStr,
      model: parsed.value.model,
      toolCount: parsed.value.tools?.length ?? 0,
      changes: transformed.changes,
    })

    const newBodyText = JSON.stringify(transformed.rewritten)
    const newBodyBytes = new TextEncoder().encode(newBodyText)

    const headers = new Headers(init?.headers ?? {})
    headers.set('content-type', 'application/json')
    headers.set('content-length', String(newBodyBytes.length))

    const response = await originalFetch(urlStr, {
      ...init,
      method: 'POST',
      headers,
      body: newBodyBytes,
    })

    const contentType = response.headers.get('content-type') ?? ''
    dbg({ event: "bridge_response", url: urlStr, status: response.status, contentType })

    if (contentType.includes('text/event-stream')) {
      // Buffer the full SSE transcript, parse bridge text, rewrite as native tool_calls
      const sseText = await response.text()
      const aggregate = parseSSETranscript(sseText)
      let rewrittenSSE = buildSSEFromBridge(aggregate)
      if (!DEBUG) rewrittenSSE = stripMarkersFromSSE(rewrittenSSE)
      dbg({
        event: "bridge_sse_rewritten",
        finishReason: aggregate.finishReason,
        contentLen: aggregate.content.length,
        reasoningLen: aggregate.reasoning.length,
      })
      return new Response(rewrittenSSE, {
        status: response.status,
        headers: {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
        },
      })
    }

    // Non-streaming (JSON) response
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
        reasoning: msg.reasoning_content ?? '',
        content: msg.content ?? '',
        finishReason: choice?.finish_reason,
        usage: v.usage,
      })
      dbg({ event: "bridge_json_rewritten", finishReason: choice?.finish_reason })
      return new Response(JSON.stringify(bridged), {
        status: response.status,
        headers: { 'content-type': 'application/json' },
      })
    }

    dbg({ event: "bridge_passthrough", url: urlStr, reason: "response not parseable" })
    return new Response(responseText, {
      status: response.status,
      headers: response.headers,
    })
  }

  // All bridge logic is handled by the fetch interceptor — no hooks needed
  return {}
}

// Strip bridge protocol markers from SSE content/reasoning deltas.
// Parses each SSE line individually so we only touch the right fields.
function stripMarkersFromSSE(sseText) {
  const markerRe = /\[\[\/?(OPENCODE_TOOL|OPENCODE_FINAL|CALL)\]\]/g
  return sseText.split('\n').map(line => {
    if (!line.startsWith('data: ')) return line
    const payload = line.slice(6).trim()
    if (!payload || payload === '[DONE]') return line
    try {
      const obj = JSON.parse(payload)
      const delta = obj?.choices?.[0]?.delta
      if (delta?.content) delta.content = delta.content.replace(markerRe, '')
      if (delta?.reasoning) delta.reasoning = delta.reasoning.replace(markerRe, '')
      return 'data: ' + JSON.stringify(obj)
    } catch {
      return line
    }
  }).join('\n')
}
