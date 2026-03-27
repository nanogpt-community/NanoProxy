"use strict";

const http = require("node:http");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const core = require("./src/core.js");

const {
  tryParseJson,
  requestNeedsBridge,
  requestNeedsXmlBridge,
  transformRequestForBridge,
  buildAggregateFromChatCompletion,
  buildChatCompletionFromBridge,
  acceptNativeJson,
  acceptNativeSSE,
  sseLine,
  createStreamingBridgeParser,
  buildBridgeResultFromText,
  getBridgeProtocol
} = core;

const LISTEN_HOST = process.env.PROXY_HOST || "127.0.0.1";
const LISTEN_PORT = Number(process.env.PROXY_PORT || "8787");
const UPSTREAM_BASE_URL = process.env.UPSTREAM_BASE_URL || "https://nano-gpt.com/api/v1";
const DEBUG_FLAG_FILE = path.join(__dirname, ".debug-logging");
const ENABLE_DEBUG_LOGS = process.env.NANO_PROXY_DEBUG === "1" || process.env.NANO_PROXY_DEBUG === "true" || fs.existsSync(DEBUG_FLAG_FILE);
const LOG_DIR = path.join(__dirname, "Logs");

if (ENABLE_DEBUG_LOGS) fs.mkdirSync(LOG_DIR, { recursive: true });
const SESSION_START = new Date().toISOString().replace(/[:.]/g, "-");
const SESSION_LOG = ENABLE_DEBUG_LOGS ? path.join(LOG_DIR, `session-${SESSION_START}.log`) : null;
let requestCounter = 0;

function log(text) {
  if (!ENABLE_DEBUG_LOGS || !SESSION_LOG) return;
  fs.appendFileSync(SESSION_LOG, text + "\n", "utf8");
}

function logSection(title, content) {
  log(`--- ${title} ---`);
  log(typeof content === "string" ? content : JSON.stringify(content, null, 2));
  log("");
}

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function redactHeaders(headersLike) {
  const out = {};
  for (const [key, value] of Object.entries(headersLike || {})) {
    out[key] = /(authorization|api-key|x-api-key)/i.test(key) ? "[redacted]" : value;
  }
  return out;
}

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

function buildUpstreamHeaders(reqHeaders, bodyLength) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(reqHeaders || {})) {
    if (key.toLowerCase() === "host") continue;
    if (Array.isArray(value)) headers.set(key, value.join(", "));
    else if (value !== undefined) headers.set(key, value);
  }
  if (bodyLength !== undefined) headers.set("content-length", String(bodyLength));
  return headers;
}

function copyResponseHeaders(upstreamHeaders, res, bodyLength) {
  upstreamHeaders.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (lower === "content-length" || lower === "content-encoding" || lower === "transfer-encoding") return;
    res.setHeader(key, value);
  });
  if (bodyLength !== undefined) res.setHeader("content-length", String(bodyLength));
}

async function fetchUpstream(req, upstreamUrl, bodyBuffer) {
  return fetch(upstreamUrl, {
    method: req.method,
    headers: buildUpstreamHeaders(req.headers, bodyBuffer.length),
    body: ["GET", "HEAD"].includes(req.method) ? undefined : bodyBuffer
  });
}

function buildInvalidBridgeRetryBuffer(rewrittenBody, protocol = "xml") {
  const retryBody = JSON.parse(JSON.stringify(rewrittenBody));
  retryBody.messages = Array.isArray(retryBody.messages) ? retryBody.messages.slice() : [];
  const content = protocol === "object"
    ? "Your previous response was invalid because it contained no visible content or tool call. Return exactly one valid JSON turn object that matches the required bridge contract. Do not return an empty response."
    : "Your previous response was invalid because it contained no visible content and no XML tool call. Do not return an empty response. If you need to act, emit the XML tool call now. If no tool is needed, provide a normal visible reply.";
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

  requestCounter++;
  const reqNum = requestCounter;
  const requestId = `${nowStamp()}-${randomUUID().slice(0, 8)}`;
  const upstreamUrl = buildUpstreamUrl(req.url);
  const reqBuffer = await readRequestBody(req);
  const reqText = reqBuffer.toString("utf8");
  const parsed = tryParseJson(reqText);
  const isJson = (req.headers["content-type"] || "").includes("application/json") && parsed.ok;

  let upstreamBuffer = reqBuffer;
  let bridgeMeta = null;
  let attemptNativeFirst = false;

  if (isJson && requestNeedsXmlBridge(parsed.value) && !requestNeedsBridge(parsed.value)) {
    attemptNativeFirst = true;
  }

  log(`\n${"=".repeat(80)}`);
  log(`REQUEST #${reqNum}  |  ${new Date().toISOString()}  |  ${req.method} ${req.url}`);
  log(`${"=".repeat(80)}`);
  if (ENABLE_DEBUG_LOGS) logSection("REQUEST HEADERS", redactHeaders(req.headers));

  if (isJson && requestNeedsXmlBridge(parsed.value) && !attemptNativeFirst) {
    bridgeMeta = transformRequestForBridge(parsed.value);
    upstreamBuffer = Buffer.from(JSON.stringify(bridgeMeta.rewritten), "utf8");
    log(`--- BRIDGE ACTIVE | Tools: [${bridgeMeta.toolNames.join(", ")}] ---\n`);
  } else if (attemptNativeFirst) {
    log(`--- NATIVE-FIRST ACTIVE | Model: ${parsed.value && parsed.value.model ? parsed.value.model : "(unknown)"} ---\n`);
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
      return;
    }

    bridgeMeta = transformRequestForBridge(parsed.value);
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
    } catch (_) {}
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
      try { writeSseComment("keepalive"); } catch (_) {}
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
      choices: [{ index: 0, delta: {}, finish_reason: finalFinishReason || "stop" }]
    });
    res.write("data: [DONE]\n\n");
    clearInterval(heartbeatTimer);
    res.end();
    console.log(`[NanoProxy] #${reqNum} SSE done. Tool calls: ${finalToolIndex}${ENABLE_DEBUG_LOGS && SESSION_LOG ? ` | Log: ${path.basename(SESSION_LOG)}` : ""}`);
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
        return;
      }

      const translated = buildChatCompletionFromBridge(aggregate, bridgeMeta.normalizedTools);
      logSection("RAW MODEL OUTPUT", aggregate.content);
      logSection("TRANSLATED RESPONSE", translated);
      const buf = Buffer.from(JSON.stringify(translated), "utf8");
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "content-length": String(buf.length) });
      res.end(buf);
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
    log(`--- PASSTHROUGH SSE (status ${upstreamResponse.status}) ---\n`);
    return;
  }

  const rawBuffer = Buffer.from(await upstreamResponse.arrayBuffer());
  copyResponseHeaders(upstreamResponse.headers, res, rawBuffer.length);
  res.writeHead(upstreamResponse.status);
  res.end(rawBuffer);
  log(`--- PASSTHROUGH (status ${upstreamResponse.status}) ---\n`);
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

