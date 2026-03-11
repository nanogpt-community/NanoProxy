"use strict";

const http = require("node:http");
const { URL } = require("node:url");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

// Import core transformation logic from extracted module
const core = require("./src/core.js");

// Destructure needed functions
const {
  requestNeedsBridge,
  transformRequestForBridge,
  parseBridgeAssistantText,
  parseSSETranscript,
  buildBridgeResultFromText,
  buildChatCompletionFromBridge,
  buildSSEFromBridge,
  buildEmptyStopRecoveryRequest,
  isEmptyBridgeStopAggregate,
  extractProgressiveToolCalls,
  sseLine,
  applyChunkToAggregate,
  detectBridgeStreamMode,
  extractStreamableFinalContent,
  tryParseJson,
  tryParseJsonLenient,
  clone,
  MAX_PARALLEL_TOOL_CALLS
} = core;

const LISTEN_HOST = process.env.PROXY_HOST || "127.0.0.1";
const LISTEN_PORT = Number(process.env.PROXY_PORT || "8787");
const UPSTREAM_BASE_URL = process.env.UPSTREAM_BASE_URL || "https://nano-gpt.com/api/v1";
const DEBUG_FLAG_FILE = path.join(__dirname, ".debug-logging");
const ENABLE_DEBUG_LOGS = process.env.NANO_PROXY_DEBUG === "1" || fs.existsSync(DEBUG_FLAG_FILE);
const LOG_DIR = path.join(__dirname, "Logs");
const ACTIVITY_LOG = path.join(LOG_DIR, "activity.log");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function appendActivity(line) {
  if (!ENABLE_DEBUG_LOGS) return;
  ensureDir(LOG_DIR);
  fs.appendFileSync(ACTIVITY_LOG, `${new Date().toISOString()} ${line}\n`, "utf8");
}

function writeJsonLog(filePath, payload) {
  if (!ENABLE_DEBUG_LOGS) return;
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
}

function appendTextLog(filePath, text) {
  if (!ENABLE_DEBUG_LOGS) return;
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, text, "utf8");
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
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function buildUpstreamHeaders(reqHeaders, bodyLength) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(reqHeaders)) {
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
    if (lower === "content-length") return;
    if (lower === "content-encoding") return;
    if (lower === "transfer-encoding") return;
    res.setHeader(key, value);
  });
  if (bodyLength !== undefined) {
    res.setHeader("content-length", String(bodyLength));
  }
}

async function proxyRequest(req, res) {
  const requestId = `${nowStamp()}-${randomUUID().slice(0, 8)}`;
  const upstreamUrl = buildUpstreamUrl(req.url);
  const streamLogPath = path.join(LOG_DIR, `${requestId}-stream.sse`);
  const reqBuffer = await readRequestBody(req);
  const reqText = reqBuffer.toString("utf8");
  const reqParsed = tryParseJson(reqText);

  appendActivity(`request.start id=${requestId} method=${req.method} path=${req.url}`);

  const requestLog = {
    id: requestId,
    time: new Date().toISOString(),
    method: req.method,
    path: req.url,
    upstreamUrl: upstreamUrl.toString(),
    headers: redactHeaders(req.headers)
  };

  let upstreamBuffer = reqBuffer;
  let bridgeMeta = null;

  if ((req.headers["content-type"] || "").includes("application/json") && reqText && reqParsed.ok) {
    requestLog.requestBodyOriginal = reqParsed.value;
    const transformed = transformRequestForBridge(reqParsed.value);
    requestLog.requestChanges = transformed.changes;
    requestLog.requestBodyRewritten = transformed.rewritten;
    bridgeMeta = {
      bridgeApplied: transformed.bridgeApplied,
      originalRequest: reqParsed.value,
      upstreamRequest: transformed.rewritten
    };
    if (transformed.bridgeApplied || transformed.changes.length > 0) {
      upstreamBuffer = Buffer.from(JSON.stringify(transformed.rewritten), "utf8");
    }
  } else if (reqText) {
    requestLog.requestBodyOriginalText = reqText;
  }

  writeJsonLog(path.join(LOG_DIR, `${requestId}-request.json`), requestLog);

  const upstreamResponse = await fetch(upstreamUrl, {
    method: req.method,
    headers: buildUpstreamHeaders(req.headers, upstreamBuffer.length),
    body: ["GET", "HEAD"].includes(req.method) ? undefined : upstreamBuffer
  });

  const contentType = upstreamResponse.headers.get("content-type") || "";
  if (contentType.includes("text/event-stream")) {
    appendActivity(`request.stream_buffered id=${requestId} status=${upstreamResponse.status}`);
    appendTextLog(
      streamLogPath,
      [
        `# request_id=${requestId}`,
        `# time=${new Date().toISOString()}`,
        `# path=${req.url}`,
        `# upstream=${upstreamUrl}`,
        `# status=${upstreamResponse.status}`,
        ""
      ].join("\n")
    );

    if (!(bridgeMeta && bridgeMeta.bridgeApplied)) {
      const streamText = await upstreamResponse.text();
      appendTextLog(streamLogPath, streamText);
      res.setHeader("content-type", "text/event-stream; charset=utf-8");
      res.setHeader("cache-control", "no-cache");
      res.setHeader("connection", "keep-alive");
      res.setHeader("content-length", Buffer.byteLength(streamText));
      res.writeHead(upstreamResponse.status);
      res.end(streamText);
      appendActivity(`request.done id=${requestId} status=${upstreamResponse.status} type=stream_passthrough stream_log=${path.basename(streamLogPath)}`);
      return;
    }

    res.setHeader("content-type", "text/event-stream; charset=utf-8");
    res.setHeader("cache-control", "no-cache");
    res.setHeader("connection", "keep-alive");
    res.writeHead(upstreamResponse.status);

    let rawBuffer = "";
    let roleSent = false;
    let reasoningSent = 0;
    let emittedToolCalls = 0;

    const ensureRole = (aggregate) => {
      if (roleSent) return;
      res.write(sseLine({
        id: aggregate.id || `chatcmpl_${randomUUID()}`,
        object: "chat.completion.chunk",
        created: aggregate.created || Math.floor(Date.now() / 1000),
        model: aggregate.model || "tool-bridge",
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }]
      }));
      roleSent = true;
    };

    const flushReasoningDelta = (aggregate) => {
      if (aggregate.reasoning.length <= reasoningSent) return;
      const deltaText = aggregate.reasoning.slice(reasoningSent);
      reasoningSent = aggregate.reasoning.length;
      ensureRole(aggregate);
      res.write(sseLine({
        id: aggregate.id || `chatcmpl_${randomUUID()}`,
        object: "chat.completion.chunk",
        created: aggregate.created || Math.floor(Date.now() / 1000),
        model: aggregate.model || "tool-bridge",
        choices: [{ index: 0, delta: { reasoning: deltaText }, finish_reason: null }]
      }));
    };

    const flushProgressiveToolCalls = (aggregate) => {
      const progressiveCalls = extractProgressiveToolCalls(aggregate.content);
      if (progressiveCalls.length <= emittedToolCalls) return;
      ensureRole(aggregate);
      for (let i = emittedToolCalls; i < progressiveCalls.length; i++) {
        const call = progressiveCalls[i];
        res.write(sseLine({
          id: aggregate.id || `chatcmpl_${randomUUID()}`,
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
                function: {
                  name: call.function.name,
                  arguments: call.function.arguments
                }
              }]
            },
            finish_reason: null
          }]
        }));
      }
      emittedToolCalls = progressiveCalls.length;
    };

    let aggregate = {
      id: null,
      model: null,
      created: null,
      reasoning: "",
      content: "",
      finishReason: null,
      usage: undefined
    };

    const consumeBridgeStream = async (response, logLabel) => {
      rawBuffer = "";
      for await (const chunk of response.body) {
        const textChunk = Buffer.from(chunk).toString("utf8");
        appendTextLog(streamLogPath, textChunk);
        rawBuffer += textChunk;

        let boundary;
        while ((boundary = rawBuffer.indexOf("\n\n")) !== -1) {
          const eventText = rawBuffer.slice(0, boundary);
          rawBuffer = rawBuffer.slice(boundary + 2);
          const line = eventText
            .split(/\r?\n/)
            .map((part) => part.trim())
            .find((part) => part.startsWith("data:"));
          if (!line) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          const parsed = tryParseJson(payload);
          if (!parsed.ok) continue;

          applyChunkToAggregate(aggregate, parsed.value);
          flushReasoningDelta(aggregate);
          flushProgressiveToolCalls(aggregate);

          if (emittedToolCalls >= MAX_PARALLEL_TOOL_CALLS) {
            aggregate.finishReason = "tool_calls_max_cap";
            try { response.body.destroy(); } catch (e) { }
            break;
          }
        }
        if (emittedToolCalls >= MAX_PARALLEL_TOOL_CALLS) break;
      }
      appendActivity(`request.stream_consumed id=${requestId} label=${logLabel} finish=${aggregate.finishReason || "null"} reasoning_len=${aggregate.reasoning.length} content_len=${aggregate.content.length}`);
    };

    await consumeBridgeStream(upstreamResponse, "initial");

    if (isEmptyBridgeStopAggregate(aggregate)) {
      appendActivity(`request.empty_stop id=${requestId}`);
      const recoveryRequest = buildEmptyStopRecoveryRequest(bridgeMeta.upstreamRequest);
      const recoveryBuffer = Buffer.from(JSON.stringify(recoveryRequest), "utf8");
      appendTextLog(streamLogPath, "\n# recovery-attempt=1\n");
      const recoveryResponse = await fetch(upstreamUrl, {
        method: req.method,
        headers: buildUpstreamHeaders(req.headers, recoveryBuffer.length),
        body: ["GET", "HEAD"].includes(req.method) ? undefined : recoveryBuffer
      });
      appendActivity(`request.recovery id=${requestId} status=${recoveryResponse.status}`);
      if ((recoveryResponse.headers.get("content-type") || "").includes("text/event-stream")) {
        aggregate = {
          id: null,
          model: null,
          created: null,
          reasoning: "",
          content: "",
          finishReason: null,
          usage: undefined
        };
        await consumeBridgeStream(recoveryResponse, "recovery");
      } else {
        const recoveryText = await recoveryResponse.text();
        appendTextLog(streamLogPath, recoveryText);
      }
    }

    if (!roleSent) ensureRole(aggregate);
    const result = buildBridgeResultFromText(aggregate.content, aggregate.reasoning);
    if (result.kind === "final") {
      const finalText = extractStreamableFinalContent(aggregate.content) || result.message.content || "";
      if (finalText) {
        res.write(sseLine({
          id: aggregate.id || `chatcmpl_${randomUUID()}`,
          object: "chat.completion.chunk",
          created: aggregate.created || Math.floor(Date.now() / 1000),
          model: aggregate.model || "tool-bridge",
          choices: [{ index: 0, delta: { content: finalText }, finish_reason: null }]
        }));
      }
      res.write(sseLine({
        id: aggregate.id || `chatcmpl_${randomUUID()}`,
        object: "chat.completion.chunk",
        created: aggregate.created || Math.floor(Date.now() / 1000),
        model: aggregate.model || "tool-bridge",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        ...(aggregate.usage ? { usage: aggregate.usage } : {})
      }));
      res.write("data: [DONE]\n\n");
      res.end();
      appendActivity(`request.done id=${requestId} status=${upstreamResponse.status} type=stream_bridge_partial stream_log=${path.basename(streamLogPath)}`);
      return;
    }

    for (const [index, call] of result.message.tool_calls.entries()) {
      if (index < emittedToolCalls) continue;
      res.write(sseLine({
        id: aggregate.id || `chatcmpl_${randomUUID()}`,
        object: "chat.completion.chunk",
        created: aggregate.created || Math.floor(Date.now() / 1000),
        model: aggregate.model || "tool-bridge",
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index,
              id: call.id,
              type: "function",
              function: {
                name: call.function.name,
                arguments: call.function.arguments
              }
            }]
          },
          finish_reason: null
        }]
      }));
    }
    res.write(sseLine({
      id: aggregate.id || `chatcmpl_${randomUUID()}`,
      object: "chat.completion.chunk",
      created: aggregate.created || Math.floor(Date.now() / 1000),
      model: aggregate.model || "tool-bridge",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      ...(aggregate.usage ? { usage: aggregate.usage } : {})
    }));
    res.write("data: [DONE]\n\n");
    res.end();
    appendActivity(`request.done id=${requestId} status=${upstreamResponse.status} type=stream_bridge_reasoning stream_log=${path.basename(streamLogPath)}`);
    return;
  }

  const responseText = await upstreamResponse.text();
  const responseParsed = tryParseJson(responseText);
  const responseLog = {
    id: requestId,
    time: new Date().toISOString(),
    status: upstreamResponse.status,
    headers: redactHeaders(Object.fromEntries(upstreamResponse.headers.entries()))
  };

  let finalText = responseText;

  if (responseParsed.ok) {
    responseLog.responseBodyOriginal = responseParsed.value;
    if (bridgeMeta && bridgeMeta.bridgeApplied) {
      let currentResponse = responseParsed.value;
      let choice = Array.isArray(currentResponse.choices) ? currentResponse.choices[0] : null;
      let message = choice && choice.message ? choice.message : {};
      let aggregate = {
        id: currentResponse.id,
        model: currentResponse.model,
        created: currentResponse.created,
        reasoning: message.reasoning_content || "",
        content: message.content || "",
        finishReason: choice ? choice.finish_reason : null,
        usage: currentResponse.usage
      };
      const bridged = buildChatCompletionFromBridge(aggregate);
      responseLog.responseChanges = ["bridge response synthesized from custom text protocol"];
      responseLog.responseBodyRewritten = bridged;
      finalText = JSON.stringify(bridged);
    } else {
      responseLog.responseChanges = [];
      responseLog.responseBodyRewritten = responseParsed.value;
    }
  } else {
    responseLog.responseBodyOriginalText = responseText;
  }

  writeJsonLog(path.join(LOG_DIR, `${requestId}-response.json`), responseLog);
  appendActivity(`request.done id=${requestId} status=${upstreamResponse.status}`);

  copyResponseHeaders(upstreamResponse.headers, res, Buffer.byteLength(finalText));
  res.writeHead(upstreamResponse.status);
  res.end(finalText);
}

async function requestHandler(req, res) {
  try {
    if (req.method === "GET" && req.url === "/health") {
      const payload = JSON.stringify({
        ok: true,
        upstream: UPSTREAM_BASE_URL,
        debugLogs: ENABLE_DEBUG_LOGS,
        ...(ENABLE_DEBUG_LOGS ? { logDir: LOG_DIR } : {}),
        toolBridgeMode: "text"
      });
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload)
      });
      res.end(payload);
      return;
    }

    await proxyRequest(req, res);
  } catch (error) {
    appendActivity(
      `request.error method=${req.method} path=${req.url} message=${error instanceof Error ? error.stack || error.message : String(error)}`
    );
    if (res.headersSent) {
      res.end();
      return;
    }
    const payload = JSON.stringify({
      error: {
        message: error instanceof Error ? error.message : String(error),
        type: "proxy_error"
      }
    });
    res.writeHead(502, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload)
    });
    res.end(payload);
  }
}

function startServer() {
  const server = http.createServer(requestHandler);
  server.listen(LISTEN_PORT, LISTEN_HOST, () => {
    appendActivity(`server.listen host=${LISTEN_HOST} port=${LISTEN_PORT} upstream=${UPSTREAM_BASE_URL} bridge=text`);
    process.stdout.write(`tool-proxy listening on http://${LISTEN_HOST}:${LISTEN_PORT} -> ${UPSTREAM_BASE_URL} (bridge=text)\n`);
  });
  return server;
}

process.on("uncaughtException", (error) => {
  appendActivity(`fatal.uncaughtException message=${error.stack || error.message}`);
});

process.on("unhandledRejection", (reason) => {
  appendActivity(`fatal.unhandledRejection message=${reason instanceof Error ? reason.stack || reason.message : String(reason)}`);
});

if (require.main === module) {
  startServer();
}

// Export core functions and server for external use
module.exports = {
  // Server
  startServer,
  
  // Re-export core functions for plugin use
  ...core
};