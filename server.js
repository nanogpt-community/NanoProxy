"use strict";

const http = require("node:http");
const { URL } = require("node:url");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const LISTEN_HOST = process.env.PROXY_HOST || "127.0.0.1";
const LISTEN_PORT = Number(process.env.PROXY_PORT || "8787");
const UPSTREAM_BASE_URL = process.env.UPSTREAM_BASE_URL || "https://nano-gpt.com/api/v1";
const DEBUG_FLAG_FILE = path.join(__dirname, ".debug-logging");
const ENABLE_DEBUG_LOGS = process.env.NANO_PROXY_DEBUG === "1" || fs.existsSync(DEBUG_FLAG_FILE);
const LOG_DIR = path.join(__dirname, "Logs");
const ACTIVITY_LOG = path.join(LOG_DIR, "activity.log");
const TOOL_BLOCK_LABEL = "opencode-tool";
const FINAL_BLOCK_LABEL = "opencode-final";
const TOOL_RESULT_LABEL = "opencode-tool-result";
const BRIDGE_MODE = process.env.PROXY_TOOL_BRIDGE_MODE || "text";
const TOOL_MODE_MARKER = "[[OPENCODE_TOOL]]";
const FINAL_MODE_MARKER = "[[OPENCODE_FINAL]]";
const TOOL_MODE_END_MARKER = "[[/OPENCODE_TOOL]]";
const FINAL_MODE_END_MARKER = "[[/OPENCODE_FINAL]]";
const TOOL_MODE_MARKER_ALIASES = ["[OPENCODE_TOOL]", TOOL_MODE_MARKER];
const FINAL_MODE_MARKER_ALIASES = ["[OPENCODE_FINAL]", FINAL_MODE_MARKER];
const TOOL_MODE_END_MARKER_ALIASES = ["[/OPENCODE_TOOL]", TOOL_MODE_END_MARKER];
const FINAL_MODE_END_MARKER_ALIASES = ["[/OPENCODE_FINAL]", FINAL_MODE_END_MARKER];
const LOOSE_TOOL_START_REGEX = /\[{1,2}\s*OPENCODE_TOOLS?\s*\]{1,2}/i;
const LOOSE_TOOL_END_REGEX = /\[{1,2}\s*\/\s*OPENCODE_TOOLS?\s*\]{1,2}/i;
const LOOSE_FINAL_START_REGEX = /\[{1,2}\s*OPENCODE_FINAL\s*\]{1,2}/i;
const LOOSE_FINAL_END_REGEX = /\[{1,2}\s*\/\s*OPENCODE_FINAL\s*\]{1,2}/i;

function buildUpstreamUrl(requestPath) {
  const base = UPSTREAM_BASE_URL.replace(/\/+$/, "");
  const suffix = String(requestPath || "").replace(/^\/+/, "");
  return `${base}/${suffix}`;
}

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

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function redactHeaders(headersLike) {
  const out = {};
  for (const [key, value] of Object.entries(headersLike || {})) {
    out[key] = /(authorization|api-key|x-api-key)/i.test(key) ? "[redacted]" : value;
  }
  return out;
}

function tryParseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error };
  }
}

function closeUnbalancedJson(text) {
  const source = String(text || "");
  const stack = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") stack.push("}");
    else if (char === "[") stack.push("]");
    else if ((char === "}" || char === "]") && stack.length > 0 && stack[stack.length - 1] === char) stack.pop();
  }
  return source + stack.reverse().join("");
}

function escapeRawControlCharsInStrings(text) {
  const source = String(text || "");
  let out = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < source.length; i++) {
    const char = source[i];

    if (inString) {
      if (escaped) {
        out += char;
        escaped = false;
        continue;
      }

      if (char === "\\") {
        out += char;
        escaped = true;
        continue;
      }

      if (char === "\"") {
        out += char;
        inString = false;
        continue;
      }

      if (char === "\n") {
        out += "\\n";
        continue;
      }

      if (char === "\r") {
        out += "\\r";
        continue;
      }

      if (char === "\t") {
        out += "\\t";
        continue;
      }

      out += char;
      continue;
    }

    if (char === "\"") {
      inString = true;
    }
    out += char;
  }

  return out;
}

function tryParseJsonLenient(text) {
  const direct = tryParseJson(text);
  if (direct.ok) return direct;

  const sanitized = escapeRawControlCharsInStrings(text);
  if (sanitized !== text) {
    const reparsed = tryParseJson(sanitized);
    if (reparsed.ok) return reparsed;
  }

  const closed = closeUnbalancedJson(sanitized);
  if (closed !== sanitized) {
    const reparsedClosed = tryParseJson(closed);
    if (reparsedClosed.ok) return reparsedClosed;
  }

  return direct;
}

function decodeJsonStringLiteral(value) {
  try {
    return JSON.parse(`"${String(value || "").replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`);
  } catch {
    return String(value || "");
  }
}

function normalizeJsonString(value) {
  if (typeof value === "string") {
    const parsed = tryParseJsonLenient(value);
    return parsed.ok ? JSON.stringify(parsed.value) : value;
  }
  if (value === undefined) return "{}";
  return JSON.stringify(value);
}

function extractBalancedSegment(text, startIndex, openChar, closeChar) {
  const source = String(text || "");
  if (startIndex < 0 || source[startIndex] !== openChar) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = startIndex; i < source.length; i++) {
    const char = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === openChar) depth++;
    else if (char === closeChar) {
      depth--;
      if (depth === 0) return source.slice(startIndex, i + 1);
    }
  }
  return null;
}

function salvageTodowriteArguments(argumentsText) {
  const todosMatch = /"todos"\s*:\s*\[([\s\S]*?)\]/.exec(String(argumentsText || ""));
  if (!todosMatch) return null;
  const todos = [];
  const itemRegex = /"content"\s*:\s*"((?:\\.|[^"\\])*)"\s*,\s*"status"\s*:\s*"((?:\\.|[^"\\])*)"\s*,\s*"priority"\s*:\s*"((?:\\.|[^"\\])*)"/g;
  let match;
  while ((match = itemRegex.exec(todosMatch[1])) !== null) {
    todos.push({
      content: decodeJsonStringLiteral(match[1]),
      status: decodeJsonStringLiteral(match[2]),
      priority: decodeJsonStringLiteral(match[3])
    });
  }
  return todos.length > 0 ? { todos } : null;
}

function salvageMalformedToolCalls(text) {
  const source = String(text || "");
  const calls = [];
  const nameRegex = /"name"\s*:\s*"([^"]+)"/g;
  let nameMatch;
  while ((nameMatch = nameRegex.exec(source)) !== null) {
    const name = nameMatch[1];
    const tail = source.slice(nameMatch.index);
    const nextNameOffset = tail.slice(1).search(/"name"\s*:\s*"/);
    const scope = nextNameOffset === -1 ? tail : tail.slice(0, nextNameOffset + 1);
    const argsMatch = /"arguments"\s*:\s*/.exec(scope);
    let argsValue = {};
    if (argsMatch) {
      const valueStart = argsMatch.index + argsMatch[0].length;
      const firstChar = scope[valueStart];
      if (firstChar === "{") {
        const argsObjectText = extractBalancedSegment(scope, valueStart, "{", "}") || closeUnbalancedJson(scope.slice(valueStart));
        const parsedArgs = tryParseJsonLenient(argsObjectText);
        if (parsedArgs.ok) {
          argsValue = parsedArgs.value;
        } else if (name === "todowrite") {
          const salvaged = salvageTodowriteArguments(argsObjectText);
          if (salvaged) argsValue = salvaged;
          else continue;
        } else {
          continue;
        }
      } else if (firstChar === "[") {
        const argsArrayText = extractBalancedSegment(scope, valueStart, "[", "]") || closeUnbalancedJson(scope.slice(valueStart));
        const parsedArgs = tryParseJsonLenient(argsArrayText);
        if (!parsedArgs.ok) continue;
        argsValue = parsedArgs.value;
      }
    }
    calls.push({ name, arguments: argsValue });
  }
  return calls.length > 0 ? calls : null;
}

function bestEffortParseToolPayload(text) {
  const source = String(text || "").trim();
  const wrappedSource = /^[{\[]/.test(source) ? source : `{${source}}`;

  const parsed = tryParseJsonLenient(source);
  if (parsed.ok && parsed.value && typeof parsed.value === "object") {
    const rawCalls = Array.isArray(parsed.value.tool_calls)
      ? parsed.value.tool_calls
      : (parsed.value.tool_calls && typeof parsed.value.tool_calls === "object" ? [parsed.value.tool_calls] : [])
        .concat(parsed.value.name ? [parsed.value] : []);
    const toolCalls = normalizeParsedToolCalls(rawCalls);
    if (toolCalls.length > 0) return toolCalls;
  }

  if (wrappedSource !== source) {
    const wrappedParsed = tryParseJsonLenient(wrappedSource);
    if (wrappedParsed.ok && wrappedParsed.value && typeof wrappedParsed.value === "object") {
      const rawCalls = Array.isArray(wrappedParsed.value.tool_calls)
        ? wrappedParsed.value.tool_calls
        : (wrappedParsed.value.tool_calls && typeof wrappedParsed.value.tool_calls === "object" ? [wrappedParsed.value.tool_calls] : [])
          .concat(wrappedParsed.value.name ? [wrappedParsed.value] : []);
      const toolCalls = normalizeParsedToolCalls(rawCalls);
      if (toolCalls.length > 0) return toolCalls;
    }
  }

  const parsedClosed = tryParseJsonLenient(closeUnbalancedJson(source));
  if (parsedClosed.ok && parsedClosed.value && typeof parsedClosed.value === "object") {
    const rawCalls = Array.isArray(parsedClosed.value.tool_calls)
      ? parsedClosed.value.tool_calls
      : (parsedClosed.value.tool_calls && typeof parsedClosed.value.tool_calls === "object" ? [parsedClosed.value.tool_calls] : [])
        .concat(parsedClosed.value.name ? [parsedClosed.value] : []);
    const toolCalls = normalizeParsedToolCalls(rawCalls);
    if (toolCalls.length > 0) return toolCalls;
  }
  const normalized = parseEmbeddedJsonPayload(text);
  if (normalized && (Array.isArray(normalized.tool_calls) || typeof normalized.name === "string")) {
    const rawCalls = Array.isArray(normalized.tool_calls) ? normalized.tool_calls : [normalized];
    const toolCalls = normalizeParsedToolCalls(rawCalls);
    if (toolCalls.length > 0) return toolCalls;
  }
  const salvagedCalls = salvageMalformedToolCalls(text);
  if (salvagedCalls) {
    const toolCalls = normalizeParsedToolCalls(salvagedCalls);
    if (toolCalls.length > 0) return toolCalls;
  }
  return null;
}

function requestNeedsBridge(body) {
  return !!(
    BRIDGE_MODE === "text" &&
    body &&
    typeof body === "object" &&
    Array.isArray(body.tools) &&
    body.tools.length > 0
  );
}

function normalizeToolDefinition(tool, index) {
  const changes = [];
  if (!tool || typeof tool !== "object") return { value: tool, changes };

  const out = clone(tool);
  if (!out.function && out.name) {
    out.type = "function";
    out.function = {
      name: out.name,
      description: out.description || "",
      parameters: out.parameters || { type: "object", properties: {} }
    };
    delete out.name;
    delete out.description;
    delete out.parameters;
    changes.push(`tools[${index}] wrapped into function shape`);
  }

  if (out.function && out.function.input_schema && !out.function.parameters) {
    out.function.parameters = out.function.input_schema;
    delete out.function.input_schema;
    changes.push(`tools[${index}].function.input_schema -> parameters`);
  }

  return { value: out, changes };
}

function normalizeTools(tools) {
  const changes = [];
  const normalized = (tools || []).map((tool, index) => {
    const item = normalizeToolDefinition(tool, index);
    changes.push(...item.changes);
    return item.value;
  });
  return { tools: normalized, changes };
}

function compactToolCatalog(tools) {
  return tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description || "",
    parameters: compactSchema(tool.function.parameters || { type: "object", properties: {} })
  }));
}

function compactSchema(schema, depth = 0) {
  if (!schema || typeof schema !== "object") return { type: "object" };

  const out = {};

  if (typeof schema.type === "string") out.type = schema.type;
  if (Array.isArray(schema.required) && schema.required.length > 0) out.required = schema.required;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) out.enum = schema.enum.slice(0, 20);

  if (schema.properties && typeof schema.properties === "object") {
    out.properties = {};
    for (const [key, value] of Object.entries(schema.properties)) {
      out.properties[key] = compactSchema(value, depth + 1);
    }
  }

  if (schema.items) {
    out.items = compactSchema(schema.items, depth + 1);
  }

  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0 && depth < 2) {
    out.anyOf = schema.anyOf.slice(0, 4).map((entry) => compactSchema(entry, depth + 1));
  }

  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0 && depth < 2) {
    out.oneOf = schema.oneOf.slice(0, 4).map((entry) => compactSchema(entry, depth + 1));
  }

  if (Array.isArray(schema.allOf) && schema.allOf.length > 0 && depth < 2) {
    out.allOf = schema.allOf.slice(0, 4).map((entry) => compactSchema(entry, depth + 1));
  }

  if (typeof schema.additionalProperties === "boolean") {
    out.additionalProperties = schema.additionalProperties;
  }

  if (!out.type && !out.properties && !out.items && !out.anyOf && !out.oneOf && !out.allOf) {
    out.type = "object";
  }

  return out;
}

function encodeToolCallsBlock(toolCalls) {
  const payload = {
    tool_calls: toolCalls.map((call) => ({
      name: call.function.name,
      arguments: typeof call.function.arguments === "string"
        ? (tryParseJson(call.function.arguments).ok ? tryParseJson(call.function.arguments).value : call.function.arguments)
        : (call.function.arguments || {})
    }))
  };
  return [
    TOOL_MODE_MARKER,
    JSON.stringify(payload, null, 2),
    TOOL_MODE_END_MARKER
  ].join("\n");
}

function encodeToolResultBlock(message) {
  const payload = {
    tool_call_id: message.tool_call_id || "",
    content: message.content || ""
  };
  return [
    "",
    "",
    `\`\`\`${TOOL_RESULT_LABEL}`,
    JSON.stringify(payload, null, 2),
    "```",
    "",
    "Continue from this tool result.",
    `Your next reply must be exactly one envelope: either ${TOOL_MODE_MARKER} ... ${TOOL_MODE_END_MARKER} or ${FINAL_MODE_MARKER} ... ${FINAL_MODE_END_MARKER}.`,
    "Do not narrate the next step in plain text.",
    "Do not say what you are about to do.",
    "Either call the next tool immediately or give the final answer envelope."
  ].join("\n");
}

function encodeUserMessageForBridge(content, options = {}) {
  const text = typeof content === "string" ? content : "";
  const firstTurn = Boolean(options.firstTurn);
  return [
    text,
    "",
    "Protocol requirements for your next reply:",
    `- Start with ${TOOL_MODE_MARKER} or ${FINAL_MODE_MARKER}.`,
    `- If you need to inspect, search, read, edit, write, or plan work, reply with ${TOOL_MODE_MARKER}.`,
    "- Do not narrate what you are about to do in plain text.",
    firstTurn
      ? "- On the first assistant turn, prefer an immediate tool call over explanation."
      : "- Continue with the next concrete action, not a narration step."
  ].join("\n");
}

function buildBridgeSystemMessage(tools) {
  const catalog = compactToolCatalog(tools);
  return [
    "Tool bridge mode is enabled.",
    "The upstream provider's native tool calling is disabled for this request.",
    "Your highest priority is protocol compliance.",
    "Every reply must begin with one of these exact markers and nothing before them:",
    `- ${TOOL_MODE_MARKER}`,
    `- ${FINAL_MODE_MARKER}`,
    "When you want to use a tool, do not answer in normal prose.",
    `For tool use, reply in this exact envelope and nothing else:`,
    TOOL_MODE_MARKER,
    JSON.stringify({ tool_calls: [{ name: "tool_name", arguments: { example: true } }] }, null, 2),
    TOOL_MODE_END_MARKER,
    "Inside the tool envelope, output valid JSON with this shape:",
    JSON.stringify({ tool_calls: [{ name: "tool_name", arguments: { example: true } }] }, null, 2),
    "Rules for tool use:",
    `- Output ${TOOL_MODE_MARKER} first and ${TOOL_MODE_END_MARKER} last.`,
    "- Do not use markdown code fences for tool replies.",
    "- Do not write any explanatory prose before, inside, or after the tool envelope.",
    "- Emit exactly one tool call per assistant turn.",
    "- Do not batch multiple tool calls together.",
    "- After each tool result, decide the next single tool call.",
    "- On the first assistant turn for a coding task, usually call a search/read/list tool first.",
    "- Use tool names exactly as listed.",
    "- arguments must be a valid JSON object.",
    "- tool_calls must contain exactly one item.",
    "Invalid response example:",
    "I will inspect the codebase first.",
    "Valid response example:",
    TOOL_MODE_MARKER,
    JSON.stringify({ tool_calls: [{ name: "read", arguments: { filePath: "src/app.js" } }] }, null, 2),
    TOOL_MODE_END_MARKER,
    `If you are giving a final answer to the user and no tool is needed, use this exact envelope:`,
    FINAL_MODE_MARKER,
    "Your final answer text goes here.",
    FINAL_MODE_END_MARKER,
    "Rules for final answers:",
    `- Output ${FINAL_MODE_MARKER} first and ${FINAL_MODE_END_MARKER} last.`,
    "- Do not use markdown or JSON for final answers.",
    "- Do not use JSON for final answers unless explicitly required.",
    "- Do not mix normal prose before either marker.",
    "Available tools:",
    JSON.stringify(catalog, null, 2)
  ].join("\n\n");
}

function translateMessagesForBridge(messages, tools) {
  const out = [];
  let bridgeInserted = false;
  let firstUserSeen = false;
  const bridgeSystem = { role: "system", content: buildBridgeSystemMessage(tools) };

  for (const message of messages || []) {
    if (message.role === "system") {
      out.push({ role: "system", content: message.content || "" });
      continue;
    }

    if (!bridgeInserted) {
      out.push(bridgeSystem);
      bridgeInserted = true;
    }

    if (message.role === "assistant") {
      if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
        out.push({ role: "assistant", content: encodeToolCallsBlock(message.tool_calls).trim() });
        continue;
      }

      const content = typeof message.content === "string" ? message.content : "";
      const reasoning = typeof message.reasoning_content === "string" ? message.reasoning_content : "";
      out.push({ role: "assistant", content: content || reasoning || "" });
      continue;
    }

    if (message.role === "tool") {
      out.push({ role: "user", content: encodeToolResultBlock(message).trim() });
      continue;
    }

    if (message.role === "user") {
      out.push({
        role: "user",
        content: encodeUserMessageForBridge(message.content || "", { firstTurn: !firstUserSeen })
      });
      firstUserSeen = true;
      continue;
    }

    out.push({ role: message.role, content: message.content || "" });
  }

  if (!bridgeInserted) {
    out.unshift(bridgeSystem);
  }

  return out;
}

function transformRequestForBridge(body) {
  const rewritten = clone(body);
  const changes = [];

  if (!requestNeedsBridge(rewritten)) {
    return { rewritten, changes, bridgeApplied: false, normalizedTools: [] };
  }

  const normalized = normalizeTools(rewritten.tools);
  changes.push(...normalized.changes);
  rewritten.messages = translateMessagesForBridge(rewritten.messages, normalized.tools);
  rewritten.tool_choice = undefined;
  rewritten.parallel_tool_calls = undefined;
  if (typeof rewritten.temperature !== "number" || rewritten.temperature > 0.2) {
    rewritten.temperature = 0.2;
    changes.push("temperature capped for bridge compliance");
  }
  if (typeof rewritten.top_p !== "number" || rewritten.top_p > 0.3) {
    rewritten.top_p = 0.3;
    changes.push("top_p capped for bridge compliance");
  }
  delete rewritten.tools;
  delete rewritten.tool_choice;
  delete rewritten.parallel_tool_calls;
  changes.push("tool bridge applied");
  changes.push("native tools removed from upstream request");
  changes.push("bridge system message injected");

  return {
    rewritten,
    changes,
    bridgeApplied: true,
    normalizedTools: normalized.tools
  };
}

function generateToolCallId() {
  return `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

function extractFencedBlock(text, label) {
  const regex = new RegExp("```" + label + "\\s*([\\s\\S]*?)```", "i");
  const match = regex.exec(text || "");
  return match ? match[1].trim() : null;
}

function extractAnyFencedBlocks(text) {
  const source = String(text || "");
  const blocks = [];
  const regex = /```([a-zA-Z0-9_-]+)?\s*([\s\S]*?)```/g;
  let match;
  while ((match = regex.exec(source)) !== null) {
    blocks.push({
      label: (match[1] || "").trim().toLowerCase(),
      content: (match[2] || "").trim()
    });
  }
  return blocks;
}

function extractBalancedJsonObjects(text) {
  const source = String(text || "");
  const results = [];

  for (let start = 0; start < source.length; start++) {
    if (source[start] !== "{") continue;

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < source.length; i++) {
      const char = source[i];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === "\"") {
          inString = false;
        }
        continue;
      }

      if (char === "\"") {
        inString = true;
        continue;
      }

      if (char === "{") depth++;
      if (char === "}") {
        depth--;
        if (depth === 0) {
          results.push(source.slice(start, i + 1));
          break;
        }
      }
    }
  }

  return results;
}

function extractBalancedJsonArrays(text) {
  const source = String(text || "");
  const results = [];

  for (let start = 0; start < source.length; start++) {
    if (source[start] !== "[") continue;

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < source.length; i++) {
      const char = source[i];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === "\"") {
          inString = false;
        }
        continue;
      }

      if (char === "\"") {
        inString = true;
        continue;
      }

      if (char === "[") depth++;
      if (char === "]") {
        depth--;
        if (depth === 0) {
          results.push(source.slice(start, i + 1));
          break;
        }
      }
    }
  }

  return results;
}

function stripCodeFenceMarkers(text) {
  return String(text || "")
    .replace(/^```[a-zA-Z0-9_-]*\s*/g, "")
    .replace(/```$/g, "")
    .trim();
}

function normalizeEmbeddedPayloadShape(value) {
  if (!value) return null;

  if (Array.isArray(value)) {
    const toolCalls = value
      .filter((item) => item && typeof item === "object")
      .map((item) => {
        if (typeof item.name === "string") return { name: item.name, arguments: item.arguments || {} };
        if (item.function && typeof item.function.name === "string") {
          return { name: item.function.name, arguments: item.function.arguments || {} };
        }
        return null;
      })
      .filter(Boolean);
    return toolCalls.length > 0 ? { tool_calls: toolCalls } : null;
  }

  if (typeof value !== "object") return null;

  if (Array.isArray(value.tool_calls)) return value;
  if (value.tool_calls && typeof value.tool_calls === "object") {
    return { tool_calls: [value.tool_calls] };
  }
  if (typeof value.name === "string") return value;
  if (value.function && typeof value.function.name === "string") {
    return {
      name: value.function.name,
      arguments: value.function.arguments || {}
    };
  }
  if (value.tool && typeof value.tool === "object" && typeof value.tool.name === "string") {
    return {
      name: value.tool.name,
      arguments: value.tool.arguments || {}
    };
  }
  if (value.tool_call && typeof value.tool_call === "object") {
    return normalizeEmbeddedPayloadShape(value.tool_call);
  }
  if (value.call && typeof value.call === "object") {
    return normalizeEmbeddedPayloadShape(value.call);
  }
  if (value.action && typeof value.action === "object") {
    return normalizeEmbeddedPayloadShape(value.action);
  }
  if (Array.isArray(value.calls)) return normalizeEmbeddedPayloadShape(value.calls);
  if (Array.isArray(value.actions)) return normalizeEmbeddedPayloadShape(value.actions);
  if (Array.isArray(value.tools)) return normalizeEmbeddedPayloadShape(value.tools);
  if (Array.isArray(value.invocations)) return normalizeEmbeddedPayloadShape(value.invocations);
  if (typeof value.content === "string") return { content: value.content };
  if (typeof value.final === "string") return { content: value.final };
  if (typeof value.answer === "string") return { content: value.answer };
  if (typeof value.response === "string") return { content: value.response };

  return null;
}

function parseEmbeddedJsonPayload(text) {
  const candidates = [
    ...extractBalancedJsonObjects(text),
    ...extractBalancedJsonArrays(text)
  ];

  for (const candidate of candidates) {
    const parsed = tryParseJsonLenient(candidate);
    if (!parsed.ok) continue;

    const normalized = normalizeEmbeddedPayloadShape(parsed.value);
    if (normalized) return normalized;
  }

  return null;
}

function parseAnyFencedJsonPayload(text) {
  const blocks = extractAnyFencedBlocks(text);
  for (const block of blocks) {
    const parsed = tryParseJsonLenient(stripCodeFenceMarkers(block.content));
    if (!parsed.ok) continue;
    const normalized = normalizeEmbeddedPayloadShape(parsed.value);
    if (normalized) return normalized;
  }
  return null;
}

function normalizeParsedToolCalls(rawCalls) {
  return rawCalls
    .filter((call) => call && typeof call === "object" && typeof call.name === "string")
    .slice(0, 1)
    .map((call) => ({
      id: generateToolCallId(),
      type: "function",
      function: {
        name: call.name,
        arguments: normalizeJsonString(call.arguments || {})
      }
    }));
}

function startsWithMarker(text, marker) {
  return String(text || "").trimStart().startsWith(marker);
}

function startsWithAnyMarker(text, markers) {
  return markers.some((marker) => startsWithMarker(text, marker));
}

function extractMarkerEnvelope(text, startMarker, endMarker) {
  const source = String(text || "");
  const start = source.indexOf(startMarker);
  if (start === -1) return null;
  const afterStart = source.slice(start + startMarker.length);
  const end = afterStart.indexOf(endMarker);
  if (end === -1) {
    return afterStart.trim();
  }
  return afterStart.slice(0, end).trim();
}

function stripMarker(text, marker) {
  const source = String(text || "");
  const trimmed = source.trimStart();
  if (!trimmed.startsWith(marker)) return source;
  return trimmed.slice(marker.length).replace(/^\s+/, "");
}

function stripAnyMarker(text, markers) {
  const source = String(text || "");
  for (const marker of markers) {
    const stripped = stripMarker(source, marker);
    if (stripped !== source) return stripped;
  }
  return source;
}

function extractAnyMarkerEnvelope(text, startMarkers, endMarkers) {
  const source = String(text || "");
  for (const startMarker of startMarkers) {
    const start = source.indexOf(startMarker);
    if (start === -1) continue;
    const afterStart = source.slice(start + startMarker.length);
    let bestEnd = -1;
    for (const endMarker of endMarkers) {
      const idx = afterStart.indexOf(endMarker);
      if (idx !== -1 && (bestEnd === -1 || idx < bestEnd)) bestEnd = idx;
    }
    if (bestEnd === -1) return afterStart.trim();
    return afterStart.slice(0, bestEnd).trim();
  }
  return null;
}

function extractLooseMarkerEnvelope(text, startRegex, endRegex) {
  const source = String(text || "");
  const startMatch = startRegex.exec(source);
  if (!startMatch) return null;
  const afterStart = source.slice(startMatch.index + startMatch[0].length);
  const endMatch = endRegex.exec(afterStart);
  if (!endMatch) return afterStart.trim();
  return afterStart.slice(0, endMatch.index).trim();
}

function parseBridgeAssistantText(text) {
  const canonicalTool = extractAnyMarkerEnvelope(text, TOOL_MODE_MARKER_ALIASES, TOOL_MODE_END_MARKER_ALIASES);
  if (canonicalTool !== null) {
    const toolCalls = bestEffortParseToolPayload(canonicalTool);
    if (toolCalls && toolCalls.length > 0) return { kind: "tool_calls", toolCalls };
    return { kind: "invalid_tool_block", raw: text };
  }

  const looseTool = extractLooseMarkerEnvelope(text, LOOSE_TOOL_START_REGEX, LOOSE_TOOL_END_REGEX);
  if (looseTool !== null) {
    const toolCalls = bestEffortParseToolPayload(looseTool);
    if (toolCalls && toolCalls.length > 0) return { kind: "tool_calls", toolCalls };
    return { kind: "invalid_tool_block", raw: text };
  }

  const canonicalFinal = extractAnyMarkerEnvelope(text, FINAL_MODE_MARKER_ALIASES, FINAL_MODE_END_MARKER_ALIASES);
  if (canonicalFinal !== null) {
    return { kind: "final", content: canonicalFinal };
  }

  const looseFinal = extractLooseMarkerEnvelope(text, LOOSE_FINAL_START_REGEX, LOOSE_FINAL_END_REGEX);
  if (looseFinal !== null) {
    return { kind: "final", content: looseFinal };
  }

  if (startsWithAnyMarker(text, TOOL_MODE_MARKER_ALIASES)) {
    return parseBridgeAssistantText(stripAnyMarker(text, TOOL_MODE_MARKER_ALIASES));
  }

  if (startsWithAnyMarker(text, FINAL_MODE_MARKER_ALIASES)) {
    return { kind: "final", content: stripAnyMarker(text, FINAL_MODE_MARKER_ALIASES) };
  }

  const toolBlock = extractFencedBlock(text, TOOL_BLOCK_LABEL);
  if (toolBlock) {
    const toolCalls = bestEffortParseToolPayload(toolBlock);
    if (toolCalls && toolCalls.length > 0) return { kind: "tool_calls", toolCalls };
  }

  const finalBlock = extractFencedBlock(text, FINAL_BLOCK_LABEL);
  if (finalBlock) {
    const parsed = tryParseJsonLenient(finalBlock);
    if (parsed.ok && parsed.value && typeof parsed.value === "object" && typeof parsed.value.content === "string") {
      return { kind: "final", content: parsed.value.content };
    }
    return { kind: "final", content: finalBlock };
  }

  const fencedJson = parseAnyFencedJsonPayload(text);
  if (fencedJson) {
    if (Array.isArray(fencedJson.tool_calls) || typeof fencedJson.name === "string") {
      const rawCalls = Array.isArray(fencedJson.tool_calls) ? fencedJson.tool_calls : [fencedJson];
      const toolCalls = normalizeParsedToolCalls(rawCalls);
      if (toolCalls.length > 0) return { kind: "tool_calls", toolCalls };
    }
    if (typeof fencedJson.content === "string") {
      return { kind: "final", content: fencedJson.content };
    }
  }

  const embedded = parseEmbeddedJsonPayload(text);
  if (embedded) {
    if (Array.isArray(embedded.tool_calls) || typeof embedded.name === "string") {
      const rawCalls = Array.isArray(embedded.tool_calls)
        ? embedded.tool_calls
        : [embedded];
      const toolCalls = normalizeParsedToolCalls(rawCalls);
      if (toolCalls.length > 0) {
        return { kind: "tool_calls", toolCalls };
      }
    }

    if (typeof embedded.content === "string") {
      return { kind: "final", content: embedded.content };
    }
  }

  return { kind: "plain", content: text || "" };
}

function parseSSETranscript(text) {
  const aggregate = {
    id: null,
    model: null,
    created: null,
    reasoning: "",
    content: "",
    finishReason: null,
    usage: undefined
  };

  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    const parsed = tryParseJson(payload);
    if (!parsed.ok) continue;
    const chunk = parsed.value;
    const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : null;
    if (!choice) continue;

    aggregate.id = aggregate.id || chunk.id || `chatcmpl_${randomUUID()}`;
    aggregate.model = aggregate.model || chunk.model || null;
    aggregate.created = aggregate.created || chunk.created || Math.floor(Date.now() / 1000);

    const delta = choice.delta || {};
    if (typeof delta.reasoning === "string") aggregate.reasoning += delta.reasoning;
    if (typeof delta.reasoning_content === "string") aggregate.reasoning += delta.reasoning_content;
    if (typeof delta.content === "string") aggregate.content += delta.content;
    if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
      aggregate.finishReason = choice.finish_reason;
    }
    if (chunk.usage) aggregate.usage = chunk.usage;
  }

  return aggregate;
}

function buildBridgeResultFromText(text, reasoning) {
  const parsed = parseBridgeAssistantText(text);
  if (parsed.kind === "tool_calls") {
    return {
      kind: "tool_calls",
      message: {
        role: "assistant",
        content: "",
        reasoning_content: reasoning || "",
        tool_calls: parsed.toolCalls
      },
      finishReason: "tool_calls"
    };
  }

  return {
    kind: "final",
    message: {
      role: "assistant",
      content: parsed.kind === "final" ? parsed.content : (parsed.content || text || ""),
      reasoning_content: reasoning || ""
    },
    finishReason: "stop"
  };
}

function buildChatCompletionFromBridge(aggregate) {
  const result = buildBridgeResultFromText(aggregate.content, aggregate.reasoning);
  const response = {
    id: aggregate.id || `chatcmpl_${randomUUID()}`,
    object: "chat.completion",
    created: aggregate.created || Math.floor(Date.now() / 1000),
    model: aggregate.model || "tool-bridge",
    choices: [
      {
        index: 0,
        finish_reason: result.finishReason,
        message: result.message
      }
    ]
  };
  if (aggregate.usage) response.usage = aggregate.usage;
  return response;
}

function sseLine(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function applyChunkToAggregate(aggregate, chunk) {
  const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : null;
  if (!choice) return;

  aggregate.id = aggregate.id || chunk.id || `chatcmpl_${randomUUID()}`;
  aggregate.model = aggregate.model || chunk.model || null;
  aggregate.created = aggregate.created || chunk.created || Math.floor(Date.now() / 1000);

  const delta = choice.delta || {};
  if (typeof delta.reasoning === "string") aggregate.reasoning += delta.reasoning;
  if (typeof delta.reasoning_content === "string") aggregate.reasoning += delta.reasoning_content;
  if (typeof delta.content === "string") aggregate.content += delta.content;
  if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
    aggregate.finishReason = choice.finish_reason;
  }
  if (chunk.usage) aggregate.usage = chunk.usage;
}

function detectBridgeStreamMode(content) {
  if (startsWithMarker(content, TOOL_MODE_MARKER)) return "tool";
  if (startsWithMarker(content, FINAL_MODE_MARKER)) return "final";
  return null;
}

function extractStreamableFinalContent(content) {
  const source = String(content || "");
  const withoutStart = startsWithMarker(source, FINAL_MODE_MARKER)
    ? stripMarker(source, FINAL_MODE_MARKER)
    : source;
  const endIndex = withoutStart.indexOf(FINAL_MODE_END_MARKER);
  return endIndex === -1 ? withoutStart : withoutStart.slice(0, endIndex);
}

function buildSSEFromBridge(aggregate) {
  const result = buildBridgeResultFromText(aggregate.content, aggregate.reasoning);
  const id = aggregate.id || `chatcmpl_${randomUUID()}`;
  const model = aggregate.model || "tool-bridge";
  const created = aggregate.created || Math.floor(Date.now() / 1000);
  let out = "";

  out += sseLine({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }]
  });

  if (aggregate.reasoning) {
    out += sseLine({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: { reasoning: aggregate.reasoning }, finish_reason: null }]
    });
  }

  if (result.kind === "tool_calls") {
    out += sseLine({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{
        index: 0,
        delta: {
          tool_calls: result.message.tool_calls.map((call, index) => ({
            index,
            id: call.id,
            type: "function",
            function: {
              name: call.function.name,
              arguments: call.function.arguments
            }
          }))
        },
        finish_reason: null
      }]
    });

    out += sseLine({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      ...(aggregate.usage ? { usage: aggregate.usage } : {})
    });
  } else {
    out += sseLine({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: { content: result.message.content }, finish_reason: null }]
    });

    out += sseLine({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      ...(aggregate.usage ? { usage: aggregate.usage } : {})
    });
  }

  out += "data: [DONE]\n\n";
  return out;
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

    const aggregate = {
      id: null,
      model: null,
      created: null,
      reasoning: "",
      content: "",
      finishReason: null,
      usage: undefined
    };

    for await (const chunk of upstreamResponse.body) {
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
      }
    }

    if (!roleSent) ensureRole(aggregate);
    const result = buildBridgeResultFromText(aggregate.content, aggregate.reasoning);
    if (result.kind === "final") {
      const finalText = result.message.content || "";
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

    res.write(sseLine({
      id: aggregate.id || `chatcmpl_${randomUUID()}`,
      object: "chat.completion.chunk",
      created: aggregate.created || Math.floor(Date.now() / 1000),
      model: aggregate.model || "tool-bridge",
      choices: [{
        index: 0,
        delta: {
          tool_calls: result.message.tool_calls.map((call, index) => ({
            index,
            id: call.id,
            type: "function",
            function: {
              name: call.function.name,
              arguments: call.function.arguments
            }
          }))
        },
        finish_reason: null
      }]
    }));
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
        toolBridgeMode: BRIDGE_MODE
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
    appendActivity(`server.listen host=${LISTEN_HOST} port=${LISTEN_PORT} upstream=${UPSTREAM_BASE_URL} bridge=${BRIDGE_MODE}`);
    process.stdout.write(`tool-proxy listening on http://${LISTEN_HOST}:${LISTEN_PORT} -> ${UPSTREAM_BASE_URL} (bridge=${BRIDGE_MODE})\n`);
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

module.exports = {
  buildBridgeResultFromText,
  buildChatCompletionFromBridge,
  buildSSEFromBridge,
  parseBridgeAssistantText,
  parseSSETranscript,
  transformRequestForBridge,
  startServer
};
