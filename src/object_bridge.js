"use strict";

const { randomUUID } = require("node:crypto");

function tryParseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error };
  }
}

function contentPartsToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : String(content);
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      if (typeof part.text === "string") return part.text;
      if (part.type === "text" && typeof part.text === "string") return part.text;
      return "";
    })
    .join("");
}

function encodeToolResultMessage(message) {
  const payload = contentPartsToText(message.content).trim();
  const toolName = typeof message.name === "string" && message.name ? message.name : "tool";
  return `[TOOL EXECUTION RESULT: ${toolName}]\n${payload}\n\n[SYSTEM INSTRUCTION: The tool '${toolName}' executed successfully. Do NOT repeat your intention or re-invoke this tool. Analyze the output above and proceed to the NEXT logical step in your ultimate plan.]`;
}

function buildObjectToolManifest(normalizedTools) {
  return normalizedTools.map((tool) => {
    const argumentsSchema = {};
    for (const arg of tool.args || []) {
      const schema = arg && arg.schema && typeof arg.schema === "object" ? JSON.parse(JSON.stringify(arg.schema)) : {};
      if (!schema.type && arg.type) schema.type = arg.type;
      if (arg.description && !schema.description) schema.description = arg.description;
      argumentsSchema[arg.name] = schema;
    }
    return {
      name: tool.name,
      description: tool.description || "",
      arguments: argumentsSchema,
      required: Array.isArray(tool.required) ? tool.required : []
    };
  });
}


function buildObjectBridgeSystemMessage(normalizedTools, parallelAllowed = true, inheritedSystemText = "") {
  const manifest = JSON.stringify(buildObjectToolManifest(normalizedTools), null, 2);
  const exampleTool = normalizedTools[0];
  const exampleArgs = {};
  if (exampleTool && Array.isArray(exampleTool.args)) {
    for (const arg of exampleTool.args) exampleArgs[arg.name] = arg.type === "string" ? "example" : {};
  }

  return [
    "# Structured Turn Contract (v1)",
    "",
    "THIS OUTPUT CONTRACT IS THE MOST IMPORTANT INSTRUCTION IN THIS MESSAGE.",
    "DO NOT IGNORE IT. DO NOT FALL BACK TO NORMAL PROSE.",
    "Return EXACTLY one JSON object and nothing else.",
    "If you reply with plain prose, markdown, or any text outside the JSON object, the response is invalid and unusable.",
    "No markdown fences. No prose before or after the JSON object.",
    "Do not start with an explanation, plan, or status update outside the JSON object.",
    "Even a single sentence before the JSON object makes the response invalid.",
    "",
    "Required field order:",
    '1. "v"',
    '2. "mode"',
    '3. "message"',
    '4. "tool_calls" (only when mode is "tool")',
    "",
    "Rules:",
    '- "v" must be 1.',
    '- "mode" must be "tool", "final", or "clarify".',
    '- "message" must always be a user-facing string.',
    '- When mode is "tool", "tool_calls" must be a non-empty array.',
    '- When mode is "final" or "clarify", do not include "tool_calls".',
    '- Prefer each tool call object to use "name" and an "arguments" object. Flattened argument fields are also accepted when needed.',
    parallelAllowed
      ? '- You may batch multiple tool calls only when they are clearly independent. Keep batches sensible; do not try to complete an entire task in one oversized turn.'
      : '- Emit exactly one tool call when mode is "tool".',
    "",
    "Examples:",
    JSON.stringify({
      v: 1,
      mode: "tool",
      message: "I will inspect the file now.",
      tool_calls: exampleTool ? [{ name: exampleTool.name, arguments: exampleArgs }] : [{ name: "read", arguments: { path: "example" } }]
    }, null, 2),
    JSON.stringify({ v: 1, mode: "final", message: "Done. The task is complete." }, null, 2),
    JSON.stringify({ v: 1, mode: "clarify", message: "Which file do you want me to update?" }, null, 2),
    "",
    "Tool manifest:",
    manifest,
    "",
    inheritedSystemText ? "Additional system instructions to follow while still obeying the JSON-only output contract:" : "",
    inheritedSystemText || "",
    inheritedSystemText ? "" : ""
  ].join("\n");
}

function encodeAssistantToolCallsMessageForObject(message) {
  const visible = contentPartsToText(message.content).trim();
  const calls = [];
  for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    const fn = call && call.function && typeof call.function.name === "string" ? call.function : null;
    if (!fn) continue;
    const parsedArgs = tryParseJson(typeof fn.arguments === "string" ? fn.arguments : "{}");
    const argsObject = parsedArgs.ok && parsedArgs.value && typeof parsedArgs.value === "object" && !Array.isArray(parsedArgs.value)
      ? parsedArgs.value
      : {};
    calls.push({ name: fn.name, arguments: argsObject });
  }

  return JSON.stringify({
    v: 1,
    mode: "tool",
    message: visible,
    tool_calls: calls
  });
}

function collectObjectBridgeSystemText(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => message && typeof message === "object" && message.role === "system")
    .map((message) => contentPartsToText(message.content).trim())
    .filter(Boolean)
    .join("\n\n");
}

function translateMessagesForObjectBridge(messages) {
  const out = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message !== "object") continue;
    const role = typeof message.role === "string" ? message.role : "user";
    if (role === "system") {
      continue;
    }
    if (role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      out.push({ role: "assistant", content: encodeAssistantToolCallsMessageForObject(message) });
      continue;
    }
    if (role === "tool") {
      out.push({ role: "user", content: encodeToolResultMessage(message) });
      continue;
    }
    out.push({ role, content: contentPartsToText(message.content) });
  }
  return out;
}

function transformRequestForObjectBridge(body, normalizedTools) {
  const rewritten = JSON.parse(JSON.stringify(body));
  const toolNames = normalizedTools.map((t) => t.name);
  const parallelAllowed = body.parallel_tool_calls !== false;
  const inheritedSystemText = collectObjectBridgeSystemText(rewritten.messages || []);
  const systemMessage = { role: "system", content: buildObjectBridgeSystemMessage(normalizedTools, parallelAllowed, inheritedSystemText) };
  const translatedMessages = translateMessagesForObjectBridge(rewritten.messages || []);
  rewritten.messages = [systemMessage].concat(translatedMessages);
  delete rewritten.tools;
  delete rewritten.tool_choice;
  delete rewritten.parallel_tool_calls;
  return {
    bridgeApplied: true,
    protocol: "object",
    normalizedTools,
    toolNames,
    rewritten
  };
}

function extractTopLevelJsonObject(text) {
  const source = String(text || "");
  const start = source.indexOf("{");
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return {
          prefix: source.slice(0, start),
          objectText: source.slice(start, i + 1),
          suffix: source.slice(i + 1)
        };
      }
    }
  }
  return null;
}

function unwrapJsonCodeFence(text) {
  const match = String(text || "").match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  return match ? match[1].trim() : null;
}

function looksLikeBridgeTurnObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function extractTopLevelJsonValue(text) {
  const source = String(text || "");
  let start = -1;
  let openChar = "";
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{" || ch === "[") {
      start = i;
      openChar = ch;
      break;
    }
  }
  if (start < 0) return null;

  const closeChar = openChar === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === openChar) depth++;
    else if (ch === closeChar) {
      depth--;
      if (depth === 0) {
        return {
          prefix: source.slice(0, start),
          valueText: source.slice(start, i + 1),
          suffix: source.slice(i + 1)
        };
      }
    }
  }
  return null;
}

function parseLooseJsonValue(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = tryParseJson(trimmed);
  return parsed.ok ? parsed.value : null;
}

function firstDefined(obj, keys) {
  if (!obj || typeof obj !== "object") return undefined;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, key) && obj[key] !== undefined) return obj[key];
  }
  return undefined;
}

function contentValueToText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return contentPartsToText(value);
  if (typeof value === "object") {
    if (typeof value.text === "string") return value.text;
    if (typeof value.content === "string") return value.content;
    if (Array.isArray(value.content)) return contentPartsToText(value.content);
    if (typeof value.message === "string") return value.message;
    if (typeof value.visible === "string") return value.visible;
  }
  return String(value);
}

function normalizeBridgeMode(mode, hasToolCalls) {
  const normalized = typeof mode === "string" ? mode.trim().toLowerCase() : "";
  if (["tool", "tools", "tool_call", "tool_calls", "action", "actions", "call", "calls"].includes(normalized)) return "tool";
  if (["clarify", "question", "ask", "needs_input", "input_required"].includes(normalized)) return "clarify";
  if (["final", "done", "complete", "completed", "response", "answer", "stop"].includes(normalized)) return "final";
  return hasToolCalls ? "tool" : "final";
}

function normalizeToolCallsContainer(value) {
  if (value == null) return [];
  const parsed = parseLooseJsonValue(value);
  if (parsed !== null) return normalizeToolCallsContainer(parsed);
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    const nested = firstDefined(value, ["tool_calls", "toolCalls", "calls", "actions", "items"]);
    if (nested !== undefined && nested !== value) return normalizeToolCallsContainer(nested);
    return [value];
  }
  return [];
}

function normalizeBridgeTurnPayload(value, depth = 0) {
  if (depth > 5 || value == null) return null;

  const parsedString = parseLooseJsonValue(value);
  if (parsedString !== null) return normalizeBridgeTurnPayload(parsedString, depth + 1);

  if (Array.isArray(value)) {
    if (value.length === 1) {
      const nested = normalizeBridgeTurnPayload(value[0], depth + 1);
      if (nested) return nested;
    }
    return value.length > 0 ? { v: 1, mode: "tool", message: "", tool_calls: value } : null;
  }

  if (typeof value !== "object") return null;

  for (const key of ["assistant", "response", "turn", "result", "output", "data", "payload", "bridge", "assistant_response"]) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const nested = normalizeBridgeTurnPayload(value[key], depth + 1);
    if (nested) {
      const outerMessage = contentValueToText(firstDefined(value, ["message", "content", "text", "reply", "visible", "assistant_message"])).trim();
      if (outerMessage && !nested.message) nested.message = outerMessage;
      return nested;
    }
  }

  const rawToolCalls = firstDefined(value, ["tool_calls", "toolCalls", "tools", "calls", "actions", "assistant_tool_calls", "tool_calls_json", "toolCallsJson", "action", "call"]);
  const toolCalls = normalizeToolCallsContainer(rawToolCalls);
  const directToolLike = typeof value.name === "string" || !!(value.function && typeof value.function === "object");
  if (toolCalls.length === 0 && directToolLike) toolCalls.push(value);

  let message = contentValueToText(firstDefined(value, ["message", "content", "text", "reply", "visible", "assistant_message", "assistantMessage"])).trim();
  if (!message && value.delta && typeof value.delta === "object") {
    message = contentValueToText(firstDefined(value.delta, ["message", "content", "text"])).trim();
  }

  if (toolCalls.length === 0 && !message) return null;

  const normalized = {
    v: 1,
    mode: normalizeBridgeMode(firstDefined(value, ["mode", "type", "status", "kind"]), toolCalls.length > 0),
    message
  };
  if (toolCalls.length > 0) {
    normalized.mode = "tool";
    normalized.tool_calls = toolCalls;
  }
  return normalized;
}

function normalizeLegacyMarkerBridgeText(text) {
  const source = String(text || "").trim();
  if (!source) return null;

  const messageMatch = /\[ASSISTANT_MESSAGE\]/i.exec(source);
  const toolMatch = /\[(?:ASSISTANT|ASSASSANT)_TOOL_CALLS_JSON\]/i.exec(source);
  if (!messageMatch && !toolMatch) return null;

  const message = messageMatch
    ? source.slice(
      messageMatch.index + messageMatch[0].length,
      toolMatch && toolMatch.index > messageMatch.index ? toolMatch.index : source.length
    ).trim()
    : "";

  if (!toolMatch) {
    return JSON.stringify({ v: 1, mode: "final", message });
  }

  const payloadText = source.slice(toolMatch.index + toolMatch[0].length).trim();
  const parsed = tryParseJson(payloadText);
  if (!parsed.ok) return null;

  const normalized = normalizeBridgeTurnPayload(parsed.value);
  if (!normalized) return null;
  if (message && !normalized.message) normalized.message = message;
  return JSON.stringify(normalized);
}

function normalizeObjectBridgeResponseText(text) {
  const source = String(text || "").trim();
  if (!source) return "";

  const candidates = [];
  const seen = new Set();
  const pushCandidate = (candidate) => {
    const normalized = String(candidate || "").trim();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    candidates.push(normalized);
  };

  pushCandidate(source);

  const unfenced = unwrapJsonCodeFence(source);
  if (unfenced) pushCandidate(unfenced);

  const legacy = normalizeLegacyMarkerBridgeText(source);
  if (legacy) pushCandidate(legacy);

  if (unfenced) {
    const unfencedLegacy = normalizeLegacyMarkerBridgeText(unfenced);
    if (unfencedLegacy) pushCandidate(unfencedLegacy);
  }

  for (const candidate of candidates) {
    const parsedWhole = tryParseJson(candidate);
    if (parsedWhole.ok) {
      const normalized = normalizeBridgeTurnPayload(parsedWhole.value);
      if (normalized) return JSON.stringify(normalized);
    }

    const extracted = extractTopLevelJsonValue(candidate);
    if (extracted) {
      const parsedValue = tryParseJson(extracted.valueText);
      if (parsedValue.ok) {
        const normalized = normalizeBridgeTurnPayload(parsedValue.value);
        if (normalized) return JSON.stringify(normalized);
      }
    }
  }

  return null;
}

function buildNativeToolCall(item) {
  return {
    id: "call_" + randomUUID().slice(0, 8),
    type: "function",
    function: {
      name: item.name,
      arguments: JSON.stringify(item.arguments)
    }
  };
}

function canonicalizeToolName(name) {
  return String(name || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function buildKnownToolNameMaps(tools) {
  const exact = new Map();
  const canonical = new Map();
  for (const tool of Array.isArray(tools) ? tools : []) {
    const name = typeof tool === "string" ? tool : tool && tool.name;
    if (typeof name !== "string" || !name.trim()) continue;
    const trimmed = name.trim();
    const lower = trimmed.toLowerCase();
    if (!exact.has(lower)) exact.set(lower, trimmed);
    const canon = canonicalizeToolName(trimmed);
    if (canon && !canonical.has(canon)) canonical.set(canon, trimmed);
  }
  return { exact, canonical };
}

function resolveKnownToolName(name, knownToolMaps) {
  const trimmed = String(name || "").trim();
  if (!trimmed) return trimmed;
  if (!knownToolMaps || (!knownToolMaps.exact.size && !knownToolMaps.canonical.size)) return trimmed;
  const exact = knownToolMaps.exact.get(trimmed.toLowerCase());
  if (exact) return exact;
  const canonical = knownToolMaps.canonical.get(canonicalizeToolName(trimmed));
  return canonical || trimmed;
}

function normalizeToolArguments(value) {
  if (value == null) return {};
  const parsed = parseLooseJsonValue(value);
  if (parsed !== null) return normalizeToolArguments(parsed);
  if (value && typeof value === "object" && !Array.isArray(value)) return JSON.parse(JSON.stringify(value));
  if (Array.isArray(value)) return { items: value };
  if (typeof value === "string") return value.trim() ? { input: value } : {};
  return { value };
}

function normalizeObjectToolCall(item, knownToolMaps) {
  const parsedItem = parseLooseJsonValue(item);
  const candidate = parsedItem !== null ? parsedItem : item;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return { ok: false, error: "Each tool call must be an object." };
  }

  const fn = candidate.function && typeof candidate.function === "object" && !Array.isArray(candidate.function)
    ? candidate.function
    : null;

  const rawName = firstDefined(candidate, ["name", "tool_name", "toolName", "tool", "call_name"])
    || firstDefined(fn, ["name", "tool_name", "toolName"]);
  if (typeof rawName !== "string" || !rawName.trim()) {
    return { ok: false, error: "Tool call name must be a non-empty string." };
  }

  const skipKeys = new Set(["name", "tool_name", "toolName", "tool", "call_name", "arguments", "args", "parameters", "params", "input", "inputs", "payload", "data", "function", "type", "id"]);
  const flatArgs = {};
  for (const [key, value] of Object.entries(candidate)) {
    if (skipKeys.has(key)) continue;
    flatArgs[key] = value;
  }
  if (fn) {
    for (const [key, value] of Object.entries(fn)) {
      if (key === "name" || skipKeys.has(key)) continue;
      if (!(key in flatArgs)) flatArgs[key] = value;
    }
  }

  const argsSource = firstDefined(candidate, ["arguments", "args", "parameters", "params", "input", "inputs", "payload", "data"])
    ?? firstDefined(fn, ["arguments", "args", "parameters", "params", "input", "inputs", "payload", "data"]);
  const argsObject = normalizeToolArguments(argsSource);
  for (const [key, value] of Object.entries(flatArgs)) {
    if (!Object.prototype.hasOwnProperty.call(argsObject, key)) argsObject[key] = value;
  }

  return {
    ok: true,
    value: {
      name: resolveKnownToolName(rawName, knownToolMaps),
      arguments: argsObject
    }
  };
}

function escapeRegExp(text) {
  return String(text || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeLooseBridgeString(text) {
  return String(text || "")
    .replace(/\\r/g, "\r")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

function findToolDefinitionByName(tools, name) {
  const resolved = canonicalizeToolName(name);
  return (Array.isArray(tools) ? tools : []).find((tool) => canonicalizeToolName(typeof tool === "string" ? tool : tool && tool.name) === resolved) || null;
}

function extractMalformedToolCallsText(source) {
  const match = /"(?:tool_calls|toolCalls|tools|calls|actions)"\s*:\s*\[/i.exec(source);
  if (!match) return null;
  const start = source.indexOf("[", match.index);
  const end = source.lastIndexOf("]");
  if (start < 0 || end <= start) return null;
  return source.slice(start + 1, end);
}

function splitMalformedToolCallChunks(arrayText) {
  const source = String(arrayText || "");
  const starts = [];
  const startRegex = /\{\s*"name"\s*:/g;
  let match;
  while ((match = startRegex.exec(source)) !== null) {
    starts.push(match.index);
  }
  const chunks = [];
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i];
    const end = i + 1 < starts.length ? starts[i + 1] : source.length;
    let chunk = source.slice(start, end).trim();
    chunk = chunk.replace(/,\s*$/, "").replace(/\s*\]+\s*$/, "").trim();
    if (chunk) chunks.push(chunk);
  }
  return chunks;
}

function cleanupLooseFieldValue(rawValue) {
  let text = String(rawValue || "").trim();
  if (!text) return "";
  if (text.startsWith('"')) {
    text = text.slice(1);
    text = text.replace(/"\s*(?:,\s*)?[}\]]*\s*$/, "");
    return decodeLooseBridgeString(text);
  }
  const parsed = parseLooseJsonValue(text.replace(/,\s*$/, ""));
  if (parsed !== null) return parsed;
  return decodeLooseBridgeString(text.replace(/[}\]]+\s*$/, "").replace(/,\s*$/, ""));
}

function salvageMalformedToolCallChunk(chunk, tools, knownToolMaps) {
  const nameMatch = /"name"\s*:\s*"([^"]+)"/i.exec(chunk);
  if (!nameMatch) return null;
  const resolvedName = resolveKnownToolName(nameMatch[1], knownToolMaps);
  const toolDef = findToolDefinitionByName(tools, resolvedName);
  const candidateKeys = new Set(["name", "arguments", "args", "parameters", "params", "input", "inputs", "payload", "data"]);
  for (const arg of Array.isArray(toolDef && toolDef.args) ? toolDef.args : []) {
    if (arg && typeof arg.name === "string") candidateKeys.add(arg.name);
  }
  if (candidateKeys.size <= 8) {
    ["filePath", "content", "oldString", "newString", "command", "description", "path", "todos", "url", "pattern"].forEach((key) => candidateKeys.add(key));
  }
  const fieldRegex = new RegExp(`"(${Array.from(candidateKeys).map(escapeRegExp).sort((a, b) => b.length - a.length).join("|")})"\\s*:`, "g");
  const matches = [];
  let match;
  while ((match = fieldRegex.exec(chunk)) !== null) {
    matches.push({ key: match[1], start: match.index, valueStart: match.index + match[0].length });
  }
  const args = {};
  for (let i = 0; i < matches.length; i++) {
    const current = matches[i];
    if (current.key === "name") continue;
    const next = matches[i + 1];
    const rawValue = chunk.slice(current.valueStart, next ? next.start : chunk.length);
    if (!rawValue.trim()) continue;
    if (["arguments", "args", "parameters", "params", "input", "inputs", "payload", "data"].includes(current.key)) {
      const parsed = parseLooseJsonValue(rawValue.trim().replace(/[}\]]+\s*$/, ""));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        Object.assign(args, parsed);
        continue;
      }
    }
    args[current.key] = cleanupLooseFieldValue(rawValue);
  }
  const normalized = normalizeObjectToolCall({ name: resolvedName, ...args }, knownToolMaps);
  return normalized.ok ? buildNativeToolCall(normalized.value) : null;
}

function salvageMalformedToolTurn(source, tools, knownToolMaps) {
  const messageMatch = /"message"\s*:\s*"([\s\S]*?)"\s*,\s*"(?:tool_calls|toolCalls|tools|calls|actions)"/i.exec(source);
  const content = messageMatch ? decodeLooseBridgeString(messageMatch[1]).trim() : "";
  const arrayText = extractMalformedToolCallsText(source);
  const chunks = splitMalformedToolCallChunks(arrayText);
  const toolCalls = [];
  for (const chunk of chunks) {
    const call = salvageMalformedToolCallChunk(chunk, tools, knownToolMaps);
    if (call) toolCalls.push(call);
  }
  if (toolCalls.length > 0) {
    return { kind: "tool_calls", content, toolCalls };
  }
  if (content) {
    return { kind: "final", content };
  }
  return null;
}
function parseObjectBridgeAssistantText(text, tools) {
  const source = String(text || "");
  const normalizedSource = normalizeObjectBridgeResponseText(source);
  const knownToolMaps = buildKnownToolNameMaps(tools);
  if (normalizedSource == null) {
    const salvaged = salvageMalformedToolTurn(source, tools, knownToolMaps);
    if (salvaged) return salvaged;
    return {
      kind: "invalid",
      error: { code: "missing_bridge_object_turn", message: "Object bridge response did not contain the required top-level JSON object." }
    };
  }

  const parsed = tryParseJson(normalizedSource);
  if (!parsed.ok || !looksLikeBridgeTurnObject(parsed.value)) {
    const salvaged = salvageMalformedToolTurn(source, tools, knownToolMaps);
    if (salvaged) return salvaged;
    return {
      kind: "invalid",
      error: { code: "invalid_json_turn", message: "Bridge object was not valid JSON." }
    };
  }

  const obj = parsed.value;
  const rawToolCalls = Array.isArray(obj.tool_calls) ? obj.tool_calls : [];
  const toolCalls = [];

  for (const item of rawToolCalls) {
    const normalized = normalizeObjectToolCall(item, knownToolMaps);
    if (!normalized.ok) continue;
    toolCalls.push(buildNativeToolCall(normalized.value));
  }

  const content = contentValueToText(obj.message).trim();
  const mode = normalizeBridgeMode(obj.mode, toolCalls.length > 0);

  if (toolCalls.length > 0 || mode === "tool") {
    if (toolCalls.length > 0) {
      return {
        kind: "tool_calls",
        content,
        toolCalls
      };
    }
    if (content) return { kind: "final", content };
    return {
      kind: "invalid",
      error: { code: "invalid_schema_turn", message: "Bridge tool turn did not contain any usable tool calls." }
    };
  }

  if (content) {
    return { kind: "final", content };
  }

  return {
    kind: "invalid",
    error: { code: "invalid_empty_turn", message: "Bridge turn did not contain visible content or usable tool calls." }
  };
}

function buildBridgeResultFromObjectText(text, reasoning, tools) {
  const parsed = parseObjectBridgeAssistantText(text, tools);
  if (parsed.kind === "invalid") {
    return {
      kind: "invalid",
      message: {
        role: "assistant",
        content: "",
        reasoning_content: reasoning || ""
      },
      finishReason: "stop",
      error: parsed.error
    };
  }
  if (parsed.kind === "tool_calls") {
    return {
      kind: "tool_calls",
      message: {
        role: "assistant",
        content: parsed.content || "",
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
      content: parsed.content || "",
      reasoning_content: reasoning || ""
    },
    finishReason: "stop"
  };
}

function buildChatCompletionFromObjectBridge(aggregate, tools) {
  const result = buildBridgeResultFromObjectText(aggregate.content, aggregate.reasoning, tools);
  const response = {
    id: aggregate.id || ("chatcmpl_" + randomUUID()),
    object: "chat.completion",
    created: aggregate.created || Math.floor(Date.now() / 1000),
    model: aggregate.model || "nanoproxy-v3",
    choices: [{
      index: 0,
      finish_reason: result.finishReason,
      message: result.message
    }]
  };
  if (aggregate.usage) response.usage = aggregate.usage;
  return response;
}

function buildSSEFromObjectBridge(aggregate, tools, sseLine) {
  const result = buildBridgeResultFromObjectText(aggregate.content, aggregate.reasoning, tools);
  const id = aggregate.id || ("chatcmpl_" + randomUUID());
  const model = aggregate.model || "nanoproxy-v3";
  const created = aggregate.created || Math.floor(Date.now() / 1000);
  let out = "";

  out += sseLine({
    id, object: "chat.completion.chunk", created, model,
    choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }]
  });

  if (aggregate.reasoning) {
    out += sseLine({
      id, object: "chat.completion.chunk", created, model,
      choices: [{ index: 0, delta: { reasoning: aggregate.reasoning }, finish_reason: null }]
    });
  }

  if (result.kind === "tool_calls") {
    if (result.message.content) {
      out += sseLine({
        id, object: "chat.completion.chunk", created, model,
        choices: [{ index: 0, delta: { content: result.message.content }, finish_reason: null }]
      });
    }
    for (const [index, call] of result.message.tool_calls.entries()) {
      out += sseLine({
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
    out += sseLine({
      id, object: "chat.completion.chunk", created, model,
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      ...(aggregate.usage ? { usage: aggregate.usage } : {})
    });
  } else {
    out += sseLine({
      id, object: "chat.completion.chunk", created, model,
      choices: [{ index: 0, delta: { content: result.message.content }, finish_reason: null }]
    });
    out += sseLine({
      id, object: "chat.completion.chunk", created, model,
      choices: [{ index: 0, delta: {}, finish_reason: result.finishReason }],
      ...(aggregate.usage ? { usage: aggregate.usage } : {})
    });
  }

  out += "data: [DONE]\n\n";
  return out;
}

function tryReadJsonString(buffer, start) {
  if (buffer[start] !== '"') return { error: "expected_string" };
  let i = start + 1;
  let escape = false;
  while (i < buffer.length) {
    const ch = buffer[i];
    if (escape) {
      if (ch === "u") {
        if (i + 4 >= buffer.length) return null;
        i += 5;
        escape = false;
        continue;
      }
      escape = false;
      i += 1;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      i += 1;
      continue;
    }
    if (ch === '"') {
      const raw = buffer.slice(start, i + 1);
      const parsed = tryParseJson(raw);
      if (!parsed.ok || typeof parsed.value !== "string") return { error: "invalid_string" };
      return { end: i + 1, value: parsed.value };
    }
    i += 1;
  }
  return null;
}

function tryReadJsonObject(buffer, start) {
  if (buffer[start] !== "{") return { error: "expected_object" };
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < buffer.length; i++) {
    const ch = buffer[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const raw = buffer.slice(start, i + 1);
        const parsed = tryParseJson(raw);
        if (!parsed.ok || !parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
          return { error: "invalid_object" };
        }
        return { end: i + 1, value: parsed.value };
      }
    }
  }
  return null;
}

class StreamingObjectParser {
  constructor(tools, callbacks) {
    this.tools = tools || [];
    this.onContent = callbacks.onContent || (() => {});
    this.onToolCall = callbacks.onToolCall || (() => {});
    this.buffer = "";
    this.toolIndex = 0;
    this.completedCalls = [];
    this.messageEmitted = false;
    this.invalid = false;
    this.mode = null;
    this.toolCallsArrayStart = -1;
    this.toolCallsCursor = -1;
    this.objectClosed = false;
  }

  _skipWhitespace(index) {
    let i = index;
    while (i < this.buffer.length && /\s/.test(this.buffer[i])) i++;
    return i;
  }

  _findKeyStart(key, fromIndex = 0) {
    return this.buffer.indexOf(`"${key}"`, fromIndex);
  }

  _findValueStartAfterKey(key, fromIndex = 0) {
    const keyStart = this._findKeyStart(key, fromIndex);
    if (keyStart < 0) return null;
    let i = keyStart + key.length + 2;
    i = this._skipWhitespace(i);
    if (i >= this.buffer.length) return null;
    if (this.buffer[i] !== ':') return { error: 'missing_colon' };
    i = this._skipWhitespace(i + 1);
    if (i >= this.buffer.length) return null;
    return { start: i, keyStart };
  }

  _scanHeader() {
    const trimmedStart = this._skipWhitespace(0);
    if (trimmedStart < this.buffer.length && this.buffer[trimmedStart] !== '{') {
      this.invalid = true;
      return;
    }

    const vPos = this._findValueStartAfterKey('v');
    if (vPos && vPos.error) { this.invalid = true; return; }
    if (!vPos) return;
    if (this.buffer[vPos.start] !== '1') { this.invalid = true; return; }

    const modePos = this._findValueStartAfterKey('mode', vPos.start);
    if (modePos && modePos.error) { this.invalid = true; return; }
    if (!modePos) return;
    const modeParsed = tryReadJsonString(this.buffer, modePos.start);
    if (modeParsed && modeParsed.error) { this.invalid = true; return; }
    if (!modeParsed) return;
    if (!["tool", "final", "clarify"].includes(modeParsed.value)) {
      this.invalid = true;
      return;
    }
    this.mode = modeParsed.value;

    const messagePos = this._findValueStartAfterKey('message', modeParsed.end);
    if (messagePos && messagePos.error) { this.invalid = true; return; }
    if (!messagePos) return;
    const messageParsed = tryReadJsonString(this.buffer, messagePos.start);
    if (messageParsed && messageParsed.error) { this.invalid = true; return; }
    if (!messageParsed) return;
    if (!this.messageEmitted) {
      this.onContent(messageParsed.value);
      this.messageEmitted = true;
    }

    if (this.mode === 'tool' && this.toolCallsArrayStart < 0) {
      const toolCallsPos = this._findValueStartAfterKey('tool_calls', messageParsed.end);
      if (toolCallsPos && toolCallsPos.error) { this.invalid = true; return; }
      if (!toolCallsPos) return;
      if (this.buffer[toolCallsPos.start] !== '[') {
        this.invalid = true;
        return;
      }
      this.toolCallsArrayStart = toolCallsPos.start;
      this.toolCallsCursor = toolCallsPos.start + 1;
    }

    if (this.mode !== 'tool') {
      const closeIndex = this.buffer.indexOf('}', messageParsed.end);
      if (closeIndex >= 0) this.objectClosed = true;
    }
  }

  _scanToolCalls() {
    if (this.invalid || this.mode !== 'tool' || this.toolCallsCursor < 0) return;

    let progressed = true;
    while (progressed && !this.invalid) {
      progressed = false;
      let i = this._skipWhitespace(this.toolCallsCursor);
      if (i >= this.buffer.length) return;
      if (this.buffer[i] === ',') {
        this.toolCallsCursor = i + 1;
        progressed = true;
        continue;
      }
      if (this.buffer[i] === ']') {
        this.toolCallsCursor = i + 1;
        const closeIndex = this.buffer.indexOf('}', this.toolCallsCursor);
        if (closeIndex >= 0) this.objectClosed = true;
        return;
      }
      if (this.buffer[i] !== '{') {
        this.invalid = true;
        return;
      }
      const parsed = tryReadJsonObject(this.buffer, i);
      if (parsed && parsed.error) {
        this.invalid = true;
        return;
      }
      if (!parsed) return;
      const normalized = normalizeObjectToolCall(parsed.value);
      if (!normalized.ok) {
        this.invalid = true;
        return;
      }
      const call = buildNativeToolCall(normalized.value);
      this.completedCalls.push(call);
      this.onToolCall(call, this.toolIndex++);
      this.toolCallsCursor = parsed.end;
      progressed = true;
    }
  }

  feed(text) {
    if (this.invalid) return;
    this.buffer += String(text || '');
    this._scanHeader();
    this._scanToolCalls();
  }

  flush() {
    this._scanHeader();
    this._scanToolCalls();
  }
}

module.exports = {
  buildObjectBridgeSystemMessage,
  transformRequestForObjectBridge,
  parseObjectBridgeAssistantText,
  buildBridgeResultFromObjectText,
  buildChatCompletionFromObjectBridge,
  buildSSEFromObjectBridge,
  StreamingObjectParser
};









