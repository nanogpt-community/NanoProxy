"use strict";

const { randomUUID } = require("node:crypto");
const {
  buildObjectBridgeSystemMessage,
  transformRequestForObjectBridge,
  parseObjectBridgeAssistantText,
  buildBridgeResultFromObjectText,
  buildChatCompletionFromObjectBridge,
  buildSSEFromObjectBridge,
  StreamingObjectParser
} = require("./object_bridge.js");

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function tryParseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error };
  }
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
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

function xmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function xmlUnescape(value) {
  return String(value ?? "")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

function decodeJsonStyleEscapes(value) {
  const source = String(value ?? "");
  if (!source.includes("\\")) return source;

  const wrapped = '"' + source
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
    .replace(/\f/g, '\\f')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029') + '"';

  const parsed = tryParseJson(wrapped);
  if (!parsed.ok || typeof parsed.value !== "string") return source;
  return parsed.value;
}

function shouldDecodeStringArg(toolName, argName) {
  const tool = String(toolName || "").toLowerCase();
  const arg = String(argName || "");
  if (tool === "edit" && (arg === "oldString" || arg === "newString")) return false;
  return true;
}

function normalizeStringArgValue(toolName, argName, value) {
  const unescaped = xmlUnescape(String(value ?? "").trim());
  return shouldDecodeStringArg(toolName, argName) ? decodeJsonStyleEscapes(unescaped) : unescaped;
}

function stripOpenTags(text) {
  return String(text ?? "").replace(/<\/?open\s*>/gi, "");
}

function normalizeToolDefinition(tool) {
  if (!tool || typeof tool !== "object") return null;
  if (tool.type === "function" && tool.function && typeof tool.function === "object") return clone(tool);
  if (typeof tool.name === "string" && tool.name.trim()) {
    return {
      type: "function",
      function: {
        name: tool.name.trim(),
        description: typeof tool.description === "string" ? tool.description : "",
        parameters: tool.parameters || tool.input_schema || { type: "object", properties: {} }
      }
    };
  }
  if (tool.function && typeof tool.function === "object" && tool.function.input_schema && !tool.function.parameters) {
    const out = clone(tool);
    out.function.parameters = out.function.input_schema;
    delete out.function.input_schema;
    return out;
  }
  return clone(tool);
}

function modelNeedsBridge(modelId) {
  if (process.env.BRIDGE_MODELS === undefined) return true;
  if (process.env.BRIDGE_MODELS.trim() === "") return false;
  const allowlist = process.env.BRIDGE_MODELS
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  const lower = String(modelId || "").toLowerCase();
  return allowlist.some((part) => lower.includes(part));
}

function getBridgeProtocol() {
  const protocol = String(process.env.BRIDGE_PROTOCOL || "object").trim().toLowerCase();
  return protocol === "object" ? "object" : "xml";
}

// ---------------------------------------------------------------------------
// Tool normalization  (OpenAI tools[] -> simple list)
// ---------------------------------------------------------------------------

function normalizeTools(tools) {
  const out = [];
  for (const tool of Array.isArray(tools) ? tools : []) {
    const normalizedTool = normalizeToolDefinition(tool);
    const fn = normalizedTool && normalizedTool.type === "function" ? normalizedTool.function : null;
    if (!fn || typeof fn.name !== "string" || !fn.name.trim()) continue;
    const parameters = fn.parameters && typeof fn.parameters === "object" ? fn.parameters : {};
    const properties = parameters.properties && typeof parameters.properties === "object" ? parameters.properties : {};
    const required = Array.isArray(parameters.required) ? parameters.required.filter((x) => typeof x === "string") : [];
    const args = Object.entries(properties).map(([name, schema]) => ({
      name,
      type: schema && typeof schema.type === "string" ? schema.type : "string",
      description: schema && typeof schema.description === "string" ? schema.description : "",
      schema: schema || {}
    }));
    out.push({
      name: fn.name.trim(),
      description: typeof fn.description === "string" ? fn.description.trim() : "",
      args,
      required
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Build tool description for the system prompt
// ---------------------------------------------------------------------------

function buildToolDescription(tool) {
  const lines = [];
  lines.push(`## ${tool.name}`);
  if (tool.description) lines.push(`Description: ${tool.description}`);
  if (tool.args.length > 0) {
    lines.push("Parameters:");
    for (const arg of tool.args) {
      const req = tool.required.includes(arg.name) ? " (required)" : "";
      const desc = arg.description ? ` - ${arg.description}` : "";
      lines.push(`- ${arg.name}: ${arg.type}${req}${desc}`);
      if (arg.type === "object" || arg.type === "array") {
        lines.push(`  Schema: ${JSON.stringify(arg.schema)}`);
      }
    }
  }
  lines.push("");
  lines.push("Usage:");
  lines.push(`<${tool.name}>`);
  for (const arg of tool.args) {
    lines.push(`<${arg.name}>${arg.type === "string" ? "value" : `{${arg.type}}`}</${arg.name}>`);
  }
  lines.push(`</${tool.name}>`);
  return lines.join("\n");
}

function buildXmlExampleForTool(tool, index, introText) {
  let out = `\n## Example ${index}: Using the "${tool.name}" tool\n`;
  if (introText) out += `<open>${introText}</open>\n`;
  out += `<${tool.name}>\n`;
  for (const arg of tool.args) {
    if (arg.type === "object" || arg.type === "array") {
      out += `<${arg.name}>{"key": "value"}</${arg.name}>\n`;
    } else {
      out += `<${arg.name}>example_value</${arg.name}>\n`;
    }
  }
  out += `</${tool.name}>\n`;
  return out;
}

function buildBatchedXmlExample(tools, startIndex) {
  if (!Array.isArray(tools) || tools.length < 2) return "";
  const [first, second] = tools;
  let out = `
## Example ${startIndex}: Batching a small independent check
`;
  out += `<open>I will check both items now, then continue after the results.</open>
`;
  for (const tool of [first, second]) {
    out += `<${tool.name}>
`;
    for (const arg of tool.args) {
      if (arg.type === "object" || arg.type === "array") {
        out += `<${arg.name}>{"key": "value"}</${arg.name}>
`;
      } else {
        out += `<${arg.name}>example_value</${arg.name}>
`;
      }
    }
    out += `</${tool.name}>
`;
  }
  return out;
}

function selectToolsForBatchedExample(tools) {
  if (!Array.isArray(tools) || tools.length < 2) return [];
  const lightweight = tools.filter((tool) => /read|glob|grep|search|find|list|ls|fetch|web|open/i.test(String(tool.name || "")));
  if (lightweight.length >= 2) return lightweight.slice(0, 2);
  return tools.slice(0, 2);
}

// ---------------------------------------------------------------------------
// System message: instruct model to use XML tool calling
// ---------------------------------------------------------------------------

function buildXmlBridgeSystemMessage(normalizedTools, parallelAllowed = true) {
  const toolDescriptions = normalizedTools.map(buildToolDescription).join("\n\n");

  // Build concrete examples, including a batched example when parallel calls are allowed
  let examples = "";
  if (normalizedTools.length > 0) {
    const exampleTools = normalizedTools.slice(0, Math.min(3, normalizedTools.length));
    let exampleIndex = 1;
    if (parallelAllowed && normalizedTools.length >= 2) {
      examples += buildBatchedXmlExample(selectToolsForBatchedExample(normalizedTools), exampleIndex++);
    }
    exampleTools.forEach((t) => {
      examples += buildXmlExampleForTool(t, exampleIndex++, `I will use ${t.name} now.`);
    });
  }

  return [
    "# Tool Use Instructions",
    "",
    "You have access to a set of tools to interact with the system.",
    "Whenever you need to take an action, you must use one of these tools by writing an XML tool call in your response.",
    "",
    "The format for calling a tool is to use an XML tag matching the tool's name, and place each parameter inside its own child XML tag. For example:",
    "",
    "<tool_name>",
    "<parameter_name>value</parameter_name>",
    "<another_parameter>value</another_parameter>",
    "</tool_name>",
    examples,
    "",
    "CRITICAL RULES:",
    "1. You MUST use the exact XML format shown above. No other format is acceptable.",
    "2. EVERY parameter must be a child XML tag inside the main tool tag.",
    "3. When your response includes one or more tool calls, begin with a brief user-facing line inside <open>...</open> before the first tool call. Do not put that user-facing update only in private reasoning.",
    "4. For tools expecting objects or arrays, place JSON formatted text inside the parameter tag.",
    "5. Do NOT use JSON tool calls, Markdown code blocks for tool calls, or generic <invoke> tags.",
    parallelAllowed
      ? "6. You may call MULTIPLE tools in a single response, but keep batches small and clearly independent. Batch reads/searches/listings when that helps. Do not try to complete an entire multi-step task in one huge response; after a meaningful batch of writes/edits/commands, continue based on the results."
      : "6. Use exactly ONE tool call per response. Do not batch multiple tool calls.",
    "7. If you intend to take an action, do NOT just describe it and then stop. Immediately follow the <open>...</open> line with the XML tool call or calls in the same response.",
    "8. RESPONSE FRAMING: Put user-facing status/progress text in <open>...</open> before the first tool call. After that, emit the XML tool call or calls.",
    "9. Supported XML subset only: exact tool-name tags, child parameter tags, and optional quoted attributes on the tool tag. Do not use namespaces, self-closing tool tags, generic wrapper tags, or XML declarations.",
    "10. Never return an empty tool-enabled response. Do not stop after reasoning alone. If you need to act, emit the XML tool call in the same response. If no tool is needed, provide a normal visible reply.",
    "",
    "# Available Tools",
    "",
    toolDescriptions,
    "",
    "Remember: for tool-call turns, the user-facing update should appear in <open>...</open>. Use small sensible batches for clearly independent actions, especially reads/searches/listings. Never leave a tool-enabled turn empty. For plain replies with no tools, just respond normally."
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Encode history: assistant messages with tool_calls -> XML
// ---------------------------------------------------------------------------

function encodeAssistantToolCallsMessage(message, toolNames) {
  const parts = [];
  const visible = contentPartsToText(message.content).trim();
  if (visible) parts.push(visible);

  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  for (const call of calls) {
    const fn = call && call.function && typeof call.function.name === "string" ? call.function : null;
    if (!fn) continue;
    const parsedArgs = tryParseJson(typeof fn.arguments === "string" ? fn.arguments : "{}");
    const argsObject = parsedArgs.ok && parsedArgs.value && typeof parsedArgs.value === "object" && !Array.isArray(parsedArgs.value)
      ? parsedArgs.value
      : {};

    const paramLines = Object.entries(argsObject).map(([name, value]) => {
      const strValue = typeof value === "string" ? value : JSON.stringify(value);
      return `<${name}>${xmlEscape(strValue)}</${name}>`;
    });

    parts.push(`<${fn.name}>\n${paramLines.join("\n")}\n</${fn.name}>`);
  }

  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Encode history: tool result messages -> XML
// ---------------------------------------------------------------------------

function encodeToolResultMessage(message) {
  const payload = contentPartsToText(message.content).trim();
  const toolName = typeof message.name === "string" && message.name ? message.name : "tool";
  return `[TOOL EXECUTION RESULT: ${toolName}]\n${payload}\n\n[SYSTEM INSTRUCTION: The tool '${toolName}' executed successfully. Do NOT repeat your intention or re-invoke this tool. Analyze the output above and proceed to the NEXT logical step in your ultimate plan.]`;
}

// ---------------------------------------------------------------------------
// Translate full message history for the XML bridge
// ---------------------------------------------------------------------------

function translateMessagesForXmlBridge(messages, toolNames) {
  const out = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message !== "object") continue;
    const role = typeof message.role === "string" ? message.role : "user";
    if (role === "system") {
      out.push({ role: "system", content: contentPartsToText(message.content) });
      continue;
    }
    if (role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      out.push({ role: "assistant", content: encodeAssistantToolCallsMessage(message, toolNames) });
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

// ---------------------------------------------------------------------------
// Determine if a request needs the XML bridge
// ---------------------------------------------------------------------------

function requestNeedsXmlBridge(body) {
  return !!(body && typeof body === "object" && Array.isArray(body.tools) && body.tools.length > 0 && Array.isArray(body.messages));
}

function requestNeedsBridge(body) {
  return !!(requestNeedsXmlBridge(body) && modelNeedsBridge(body && body.model));
}

// ---------------------------------------------------------------------------
// Transform the request: strip tools, inject system prompt, rewrite history
// ---------------------------------------------------------------------------

function transformRequestForXmlBridge(body) {
  if (getBridgeProtocol() === "object") return transformRequestForObjectBridge(body, normalizeTools(body && body.tools));

  const rewritten = clone(body);
  const normalizedTools = normalizeTools(rewritten.tools);
  const toolNames = normalizedTools.map((t) => t.name);
  const parallelAllowed = body.parallel_tool_calls !== false;
  const systemMessage = { role: "system", content: buildXmlBridgeSystemMessage(normalizedTools, parallelAllowed) };
  const translatedMessages = translateMessagesForXmlBridge(rewritten.messages || [], toolNames);
  rewritten.messages = [systemMessage].concat(translatedMessages);
  delete rewritten.tools;
  delete rewritten.tool_choice;
  delete rewritten.parallel_tool_calls;
  return {
    bridgeApplied: true,
    protocol: "xml",
    normalizedTools,
    toolNames,
    rewritten
  };
}

// ---------------------------------------------------------------------------
// Parse tool calls from the model's response using known tool names
// ---------------------------------------------------------------------------

function parseXmlAttributes(raw) {
  const attrs = {};
  const source = String(raw || "");
  const regex = /([A-Za-z_][\w.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let match;
  while ((match = regex.exec(source))) {
    const key = String(match[1]);
    const value = xmlUnescape(match[3] !== undefined ? match[3] : match[4]);
    attrs[key] = value;
    attrs[key.toLowerCase()] = value;
  }
  return attrs;
}

function normalizeToolSpec(tool) {
  if (typeof tool === "string") return { name: tool, args: [] };
  if (tool && typeof tool === "object" && typeof tool.name === "string") {
    return { name: tool.name, args: Array.isArray(tool.args) ? tool.args : [] };
  }
  return null;
}

function extractToolBlocks(text, tools) {
  const source = String(text || "");
  if (!Array.isArray(tools) || tools.length === 0) return [];

  const matches = [];
  for (const tool of tools) {
    const spec = normalizeToolSpec(tool);
    if (!spec || !spec.name) continue;
    const escaped = spec.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const toolRegex = new RegExp(`<${escaped}(?:\\s+[^>]*)?>([\\s\\S]*?)<\\/${escaped}\\s*>`, "gi");
    let toolMatch;
    while ((toolMatch = toolRegex.exec(source))) {
      matches.push({
        toolName: spec.name,
        toolArgsDef: spec.args,
        fullMatch: toolMatch[0],
        toolBody: toolMatch[1].trim(),
        start: toolMatch.index,
        end: toolMatch.index + toolMatch[0].length
      });
    }
  }

  matches.sort((a, b) => a.start - b.start);
  return matches;
}

function extractGenericXmlArguments(toolName, toolBody, attrs) {
  const args = {};
  const childRegex = /<([A-Za-z_][\w.-]*)(?:\s+[^>]*)?>([\s\S]*?)<\/\1\s*>/g;
  let match;
  while ((match = childRegex.exec(toolBody))) {
    args[match[1]] = normalizeStringArgValue(toolName, match[1], match[2]);
  }
  for (const [key, value] of Object.entries(attrs || {})) {
    if (args[key] === undefined) args[key] = normalizeStringArgValue(toolName, key, value);
  }
  return args;
}

function buildToolCallFromBlock(block) {
  const toolBody = block.toolBody;
  const toolArgsDef = Array.isArray(block.toolArgsDef) ? block.toolArgsDef : [];
  const stringifiedArgs = {};
  const rawJsonArgs = {};
  const isSingleArg = toolArgsDef.length === 1;
  let matchedAnyArg = false;
  const attrs = parseXmlAttributes(block.fullMatch.match(/^<[^>]+>/)?.[0] || "");

  if (toolArgsDef.length === 0) {
    const genericArgs = extractGenericXmlArguments(block.toolName, toolBody, attrs);
    const jsonParts = Object.entries(genericArgs).map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`);
    return {
      id: "call_" + randomUUID().slice(0, 8),
      type: "function",
      function: {
        name: block.toolName,
        arguments: `{${jsonParts.join(",")}}`
      }
    };
  }

  for (const argDef of toolArgsDef) {
    const argName = argDef.name;
    const argNameEscaped = argName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const argRegex = new RegExp(`<${argNameEscaped}(?:\\s+[^>]*)?>([\\s\\S]*?)<\\/${argNameEscaped}\\s*>`, "i");
    const argMatch = argRegex.exec(toolBody);

    let extractedValue = null;
    if (argMatch) {
      extractedValue = argMatch[1].trim();
      matchedAnyArg = true;
    } else if (attrs[argName] !== undefined || attrs[argName.toLowerCase()] !== undefined) {
      extractedValue = attrs[argName] !== undefined ? attrs[argName] : attrs[argName.toLowerCase()];
      matchedAnyArg = true;
    }

    if (extractedValue !== null) {
      extractedValue = xmlUnescape(extractedValue);
      if (argDef.type === "object" || argDef.type === "array") {
        rawJsonArgs[argName] = extractedValue;
      } else {
        stringifiedArgs[argName] = decodeJsonStyleEscapes(extractedValue);
      }
    }
  }

  if (!matchedAnyArg && isSingleArg && toolBody.length > 0) {
    const argDef = toolArgsDef[0];
    let extractedValue = xmlUnescape(toolBody);
    extractedValue = extractedValue.replace(/^\s*```[a-z]*\r?\n/i, "").replace(/\r?\n```\s*$/i, "").trim();

    if (argDef.type === "object" || argDef.type === "array") {
      rawJsonArgs[argDef.name] = extractedValue;
    } else {
      stringifiedArgs[argDef.name] = decodeJsonStyleEscapes(extractedValue);
    }
  }

  const jsonParts = [];
  for (const [k, v] of Object.entries(stringifiedArgs)) {
    jsonParts.push(`${JSON.stringify(k)}:${JSON.stringify(v)}`);
  }
  for (const [k, v] of Object.entries(rawJsonArgs)) {
    jsonParts.push(`${JSON.stringify(k)}:${v}`);
  }

  return {
    id: "call_" + randomUUID().slice(0, 8),
    type: "function",
    function: {
      name: block.toolName,
      arguments: `{${jsonParts.join(",")}}`
    }
  };
}

function parseToolCallsFromText(text, tools) {
  return extractToolBlocks(text, tools).map(buildToolCallFromBlock);
}

// ---------------------------------------------------------------------------
// Parse the assistant's response into structured result
// ---------------------------------------------------------------------------

function parseXmlAssistantText(text, tools) {
  const source = String(text || "");
  const blocks = extractToolBlocks(source, tools);
  const toolCalls = blocks.map(buildToolCallFromBlock);

  if (toolCalls.length > 0) {
    let visibleText = "";
    let cursor = 0;
    for (const block of blocks) {
      visibleText += source.slice(cursor, block.start);
      cursor = block.end;
    }
    visibleText += source.slice(cursor);
    return { kind: "tool_calls", content: stripOpenTags(visibleText).trim(), toolCalls };
  }

  return { kind: "final", content: stripOpenTags(source).trim() };
}

function isInvalidBridgeCompletion(parsed, tools) {
  const hasTools = Array.isArray(tools) && tools.length > 0;
  if (!hasTools) return false;
  if (!parsed || parsed.kind !== "final") return false;
  return !String(parsed.content || "").trim();
}

// ---------------------------------------------------------------------------
// Build native OpenAI response from parsed XML
// ---------------------------------------------------------------------------

function buildBridgeResultFromText(text, reasoning, tools) {
  if (getBridgeProtocol() === "object") {
    return buildBridgeResultFromObjectText(text, reasoning, tools);
  }
  const parsed = parseXmlAssistantText(text, tools);
  if (isInvalidBridgeCompletion(parsed, tools)) {
    const recoveredFromReasoning = parseXmlAssistantText(reasoning, tools);
    if (recoveredFromReasoning && recoveredFromReasoning.kind === "tool_calls" && Array.isArray(recoveredFromReasoning.toolCalls) && recoveredFromReasoning.toolCalls.length > 0) {
      return {
        kind: "tool_calls",
        message: {
          role: "assistant",
          content: "",
          reasoning_content: recoveredFromReasoning.content || "",
          tool_calls: recoveredFromReasoning.toolCalls
        },
        finishReason: "tool_calls"
      };
    }
    return {
      kind: "invalid",
      message: {
        role: "assistant",
        content: "",
        reasoning_content: reasoning || ""
      },
      finishReason: "stop",
      error: {
        code: "invalid_bridge_completion",
        message: "Upstream returned no visible content or tool call for a tool-enabled turn."
      }
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

// ---------------------------------------------------------------------------
// Aggregate SSE chunks / JSON completion into unified structure
// ---------------------------------------------------------------------------

function buildAggregateFromChatCompletion(payload) {
  const choice = Array.isArray(payload && payload.choices) ? payload.choices[0] : null;
  const message = choice && choice.message && typeof choice.message === "object" ? choice.message : {};
  return {
    id: payload && payload.id,
    model: payload && payload.model,
    created: payload && payload.created,
    usage: payload && payload.usage,
    reasoning: typeof message.reasoning_content === "string"
      ? message.reasoning_content
      : (typeof message.reasoning === "string" ? message.reasoning : ""),
    content: contentPartsToText(message.content),
    finishReason: choice && choice.finish_reason != null ? choice.finish_reason : null
  };
}


function looksLikeXmlToolPayload(text) {
  const source = String(text || "").trim();
  if (!source || !source.startsWith("<")) return false;
  return /<([A-Za-z_][\w.-]*)(?:\s+[^>]*)?>[\s\S]*<\/\1\s*>/.test(source);
}

function shouldFallbackFromNativeText(text, finishReason) {
  const content = contentPartsToText(text).trim();
  if (finishReason === "tool_calls") return true;
  if (!content) return true;
  if (looksLikeXmlToolPayload(content)) return true;
  return false;
}

function acceptNativeJson(status, payload) {
  if (status < 200 || status >= 300) return false;
  const choice = Array.isArray(payload && payload.choices) ? payload.choices[0] : null;
  if (!choice) return false;
  const message = choice && choice.message && typeof choice.message === "object" ? choice.message : {};
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) return true;
  return !shouldFallbackFromNativeText(message.content, choice && choice.finish_reason != null ? choice.finish_reason : null);
}

function acceptNativeSSE(status, streamText) {
  if (status < 200 || status >= 300) return false;
  const aggregate = { content: "", finishReason: null, nativeToolCallsSeen: false };
  const events = String(streamText || "").split(/\n\n+/);
  for (const eventText of events) {
    const data = eventText
      .split(/\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();
    if (!data || data === "[DONE]") continue;
    const parsed = tryParseJson(data);
    if (!parsed.ok) continue;
    const choice = Array.isArray(parsed.value && parsed.value.choices) ? parsed.value.choices[0] : null;
    if (!choice || typeof choice !== "object") continue;
    const delta = choice.delta && typeof choice.delta === "object" ? choice.delta : {};
    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) aggregate.nativeToolCallsSeen = true;
    if (Array.isArray(choice.message && choice.message.tool_calls) && choice.message.tool_calls.length > 0) aggregate.nativeToolCallsSeen = true;
    if (delta.content !== undefined) aggregate.content += contentPartsToText(delta.content);
    if (choice.message && choice.message.content !== undefined) aggregate.content += contentPartsToText(choice.message.content);
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) aggregate.finishReason = choice.finish_reason;
  }
  if (aggregate.nativeToolCallsSeen) return true;
  return !shouldFallbackFromNativeText(aggregate.content, aggregate.finishReason);
}

function buildChatCompletionFromXmlBridge(aggregate, tools) {
  const result = buildBridgeResultFromText(aggregate.content, aggregate.reasoning, tools);
  const response = {
    id: aggregate.id || ("chatcmpl_" + randomUUID()),
    object: "chat.completion",
    created: aggregate.created || Math.floor(Date.now() / 1000),
    model: aggregate.model || "nanoproxy-v2",
    choices: [{
      index: 0,
      finish_reason: result.finishReason,
      message: result.message
    }]
  };
  if (aggregate.usage) response.usage = aggregate.usage;
  return response;
}

// ---------------------------------------------------------------------------
// SSE helpers
// ---------------------------------------------------------------------------

function sseLine(payload) {
  return "data: " + JSON.stringify(payload) + "\n\n";
}

function applyChunkToAggregate(aggregate, chunk) {
  const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : null;
  if (!choice) return;
  aggregate.id = aggregate.id || chunk.id || ("chatcmpl_" + randomUUID());
  aggregate.model = aggregate.model || chunk.model || null;
  aggregate.created = aggregate.created || chunk.created || Math.floor(Date.now() / 1000);
  const delta = choice.delta || {};
  if (typeof delta.reasoning === "string") aggregate.reasoning += delta.reasoning;
  if (typeof delta.reasoning_content === "string") aggregate.reasoning += delta.reasoning_content;
  if (typeof delta.content === "string") aggregate.content += delta.content;
  if (choice.finish_reason != null) aggregate.finishReason = choice.finish_reason;
  if (chunk.usage) aggregate.usage = chunk.usage;
}

function parseSSETranscript(text) {
  const aggregate = {
    id: null,
    model: null,
    created: null,
    reasoning: "",
    content: "",
    finishReason: null,
    usage: null
  };
  const chunks = String(text || "").split(/\n\n+/);
  for (const block of chunks) {
    const lines = block.split(/\r?\n/).filter((line) => line.startsWith("data:"));
    for (const line of lines) {
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      const parsed = tryParseJson(payload);
      if (!parsed.ok) continue;
      applyChunkToAggregate(aggregate, parsed.value);
    }
  }
  return aggregate;
}

// ---------------------------------------------------------------------------
// Build SSE output from XML bridge result
// ---------------------------------------------------------------------------

function buildSSEFromXmlBridge(aggregate, tools) {
  const result = buildBridgeResultFromText(aggregate.content, aggregate.reasoning, tools);
  const id = aggregate.id || ("chatcmpl_" + randomUUID());
  const model = aggregate.model || "nanoproxy-v2";
  const created = aggregate.created || Math.floor(Date.now() / 1000);
  let out = "";

  // Role chunk
  out += sseLine({
    id, object: "chat.completion.chunk", created, model,
    choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }]
  });

  // Reasoning chunk (if any)
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
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      ...(aggregate.usage ? { usage: aggregate.usage } : {})
    });
  }

  out += "data: [DONE]\n\n";
  return out;
}

// ---------------------------------------------------------------------------
// Streaming XML Parser for On-the-Fly Translation 
// ---------------------------------------------------------------------------

class StreamingXmlParser {
  constructor(tools, callbacks) {
    this.tools = tools || [];
    this.onContent = callbacks.onContent || (() => {});
    this.onToolCall = callbacks.onToolCall || (() => {});
    this.mode = "text"; 
    this.buffer = "";
    this.activeTool = null;
    this.toolIndex = 0;
    this.completedCalls = [];
  }

  feed(text) {
    for (const char of text) {
      if (this.mode === "text") {
        if (char === "<") {
          this.mode = "buffering";
          this.buffer = "<";
        } else {
          this.onContent(char);
        }
      } else if (this.mode === "buffering") {
        this.buffer += char;
        let couldBeTool = false;
        let matchedTool = null;
        for (const t of this.tools) {
          const tName = typeof t === "string" ? t : t.name;
          const prefix = `<${tName}`;
          if (prefix.startsWith(this.buffer)) {
            couldBeTool = true;
            continue;
          }
          if (this.buffer.startsWith(prefix)) {
            const nextChar = this.buffer[prefix.length];
            if (nextChar === undefined) {
              couldBeTool = true;
              continue;
            }
            if (nextChar === ">" || /\s/.test(nextChar)) {
              if (this.buffer.endsWith(">")) matchedTool = t;
              else couldBeTool = true;
            }
          }
        }
        
        if (matchedTool) {
          this.mode = "tool";
          this.activeTool = matchedTool;
        } else if (!couldBeTool) {
          this.onContent(this.buffer);
          this.mode = "text";
          this.buffer = "";
        }
      } else if (this.mode === "tool") {
        this.buffer += char;
        const activeName = typeof this.activeTool === "string" ? this.activeTool : this.activeTool.name;
        if (this.buffer.endsWith(`</${activeName}>`)) {
          const parsed = parseToolCallsFromText(this.buffer, [this.activeTool]);
          if (parsed.length > 0) {
            this.completedCalls.push(parsed[0]);
            this.onToolCall(parsed[0], this.toolIndex++);
          }
          this.mode = "text";
          this.buffer = "";
          this.activeTool = null;
        }
      }
    }
  }

  flush() {
    if (this.buffer.length > 0) {
      if (this.mode === "tool") {
        const activeName = typeof this.activeTool === "string" ? this.activeTool : this.activeTool.name;
        this.buffer += `</${activeName}>`;
        
        const parsed = parseToolCallsFromText(this.buffer, [this.activeTool]);
        if (parsed.length > 0) {
          this.completedCalls.push(parsed[0]);
          this.onToolCall(parsed[0], this.toolIndex++);
        }
      } else {
        this.onContent(this.buffer);
      }
      this.buffer = "";
    }
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

function transformRequestForBridge(body) {
  return getBridgeProtocol() === "object"
    ? transformRequestForObjectBridge(body, normalizeTools(body && body.tools))
    : transformRequestForXmlBridge(body);
}

function parseBridgeAssistantText(text, tools) {
  return getBridgeProtocol() === "object"
    ? parseObjectBridgeAssistantText(text, tools)
    : parseXmlAssistantText(text, tools);
}

function buildChatCompletionFromBridge(aggregate, tools) {
  return getBridgeProtocol() === "object"
    ? buildChatCompletionFromObjectBridge(aggregate, tools)
    : buildChatCompletionFromXmlBridge(aggregate, tools);
}

function buildSSEFromBridge(aggregate, tools, lineBuilder = sseLine) {
  return getBridgeProtocol() === "object"
    ? buildSSEFromObjectBridge(aggregate, tools, lineBuilder)
    : buildSSEFromXmlBridge(aggregate, tools, lineBuilder);
}

function createStreamingBridgeParser(tools, callbacks) {
  return getBridgeProtocol() === "object"
    ? new StreamingObjectParser(tools, callbacks)
    : new StreamingXmlParser(tools, callbacks);
}

module.exports = {
  tryParseJson,
  clone,
  contentPartsToText,
  xmlEscape,
  xmlUnescape,
  normalizeTools,
  getBridgeProtocol,
  buildXmlBridgeSystemMessage,
  buildObjectBridgeSystemMessage,
  encodeAssistantToolCallsMessage,
  encodeToolResultMessage,
  translateMessagesForXmlBridge,
  modelNeedsBridge,
  requestNeedsBridge,
  requestNeedsXmlBridge,
  transformRequestForXmlBridge,
  transformRequestForObjectBridge: (body) => transformRequestForObjectBridge(body, normalizeTools(body && body.tools)),
  transformRequestForBridge,
  parseToolCallsFromText,
  parseXmlAssistantText,
  parseObjectBridgeAssistantText,
  parseBridgeAssistantText,
  isInvalidBridgeCompletion,
  buildBridgeResultFromText,
  buildBridgeResultFromObjectText,
  buildAggregateFromChatCompletion,
  acceptNativeJson,
  acceptNativeSSE,
  parseSSETranscript,
  buildChatCompletionFromXmlBridge,
  buildChatCompletionFromObjectBridge,
  buildChatCompletionFromBridge,
  buildSSEFromXmlBridge,
  buildSSEFromObjectBridge,
  buildSSEFromBridge,
  sseLine,
  applyChunkToAggregate,
  StreamingXmlParser,
  StreamingObjectParser,
  createStreamingBridgeParser
};

