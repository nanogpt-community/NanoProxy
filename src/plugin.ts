import type { Plugin, Hooks } from "@opencode-ai/plugin"

// Session state to track streaming accumulations
const sessionAggregates = new Map<string, {
  reasoning: string
  content: string
  toolCalls: Array<{
    id: string
    name: string
    arguments: string
  }>
  finishReason: string | null
}>()

// Track which sessions are in bridge mode (have tools)
const bridgeSessions = new Set<string>()

// Track session tools for bridge mode
const sessionTools = new Map<string<any[]>()

// Track session models for flavor detection
const sessionModels = new Map<string, string>()

// Marker constants - must match core.js
const TOOL_MODE_MARKER = "[[OPENCODE_TOOL]]"
const FINAL_MODE_MARKER = "[[OPENCODE_FINAL]]"
const TOOL_MODE_END_MARKER = "[[/OPENCODE_TOOL]]"
const FINAL_MODE_END_MARKER = "[[/OPENCODE_FINAL]]"
const CALL_MODE_MARKER = "[[CALL]]"
const CALL_MODE_END_MARKER = "[[/CALL]]"

/**
 * Detect bridge flavor based on model ID
 */
function getBridgeFlavor(modelId: string): "kimi" | "default" {
  const lower = String(modelId || "").toLowerCase()
  if (lower.includes("moonshotai/kimi") || lower.includes("kimi-k2.5") || lower.includes("kimi")) {
    return "kimi"
  }
  return "default"
}

/**
 * Generate a unique tool call ID
 */
function generateToolCallId(): string {
  return `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`
}

/**
 * Parse JSON leniently
 */
function tryParseJson(text: string): { ok: boolean; value?: any; error?: Error } {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch (error) {
    return { ok: false, error: error as Error }
  }
}

/**
 * Normalize JSON string
 */
function normalizeJsonString(value: any): string {
  if (typeof value === "string") {
    const parsed = tryParseJson(value)
    return parsed.ok ? JSON.stringify(parsed.value) : value
  }
  if (value === undefined) return "{}"
  return JSON.stringify(value)
}

/**
 * Extract content from message parts
 */
function contentPartsToText(content: any): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((part: any) => {
        if (typeof part === "string") return part
        if (part && typeof part === "object") {
          if (typeof part.text === "string") return part.text
          if (typeof part.content === "string") return part.content
        }
        return ""
      })
      .filter(Boolean)
      .join("")
  }
  if (content && typeof content === "object") {
    if (typeof content.text === "string") return content.text
    if (typeof content.content === "string") return content.content
  }
  return ""
}

/**
 * Build bridge system message for tool-enabled requests
 */
function buildBridgeSystemMessage(tools: any[], flavor: "kimi" | "default" = "default"): string {
  const toolNames = tools.map(t => t.function?.name).filter(Boolean)
  const callExample = flavor === "kimi"
    ? { tool_name: "tool_name", tool_input: { example: true } }
    : { name: "tool_name", arguments: { example: true } }
  const validReadExample = flavor === "kimi"
    ? { tool_name: "read", tool_input: { filePath: "src/app.js" } }
    : { name: "read", arguments: { filePath: "src/app.js" } }

  return [
    "Tool bridge mode is enabled.",
    "The upstream provider's native tool calling is disabled for this request.",
    "Your highest priority is protocol compliance.",
    "Only two reply formats are valid.",
    `1. Tool format: ${TOOL_MODE_MARKER} ... ${TOOL_MODE_END_MARKER}`,
    `2. Final format: ${FINAL_MODE_MARKER} ... ${FINAL_MODE_END_MARKER}`,
    "Do not output anything before the opening marker.",
    "When you want to use a tool, do not answer in normal prose.",
    "Tool format example:",
    TOOL_MODE_MARKER,
    CALL_MODE_MARKER,
    JSON.stringify(callExample, null, 2),
    CALL_MODE_END_MARKER,
    TOOL_MODE_END_MARKER,
    "Inside the tool envelope, emit one or more CALL blocks. Each CALL block contains one tool call as JSON.",
    "Rules for tool use:",
    `- Output ${TOOL_MODE_MARKER} first and ${TOOL_MODE_END_MARKER} last.`,
    `- For each tool call, wrap it in ${CALL_MODE_MARKER} and ${CALL_MODE_END_MARKER}.`,
    "- Do not use markdown code fences for tool replies.",
    "- Do not write any explanatory prose before, inside, or after the tool envelope.",
    "- Do not use legacy bracketed formats like [question], [write], [read], or [toolname].",
    "- Do not output raw tool_calls JSON unless recovery is needed; CALL blocks are the required format.",
    flavor === "kimi"
      ? "- For Kimi, each CALL JSON object must use tool_name and tool_input. Do not use name/arguments."
      : "- Each CALL JSON object must use name and arguments. Do not use tool_name/tool_input.",
    "- You may batch up to 5 independent tool calls per reply.",
    "- If sequencing matters, emit only the next required tool call.",
    "- For edit, oldString must be unique in the target file. Include enough surrounding context to identify one location.",
    "- If edit would likely match multiple locations, read more of the file first and then retry with a larger oldString.",
    "- If important clarification is missing, use the question tool instead of inventing requirements.",
    "- After each tool result, decide the next tool call or CALL batch.",
    toolNames.includes("task") ? "- If you use the 'task' tool, YOU MUST provide both `prompt` and `subagent_type` parameters." : null,
    toolNames.includes("todowrite") ? "- For complex tasks, use the todowrite tool to maintain a structured plan for the code you write directly." : null,
    "- Use tool names exactly as listed.",
    "- arguments must be a valid JSON object.",
    "Valid response example:",
    TOOL_MODE_MARKER,
    CALL_MODE_MARKER,
    JSON.stringify(validReadExample, null, 2),
    CALL_MODE_END_MARKER,
    TOOL_MODE_END_MARKER,
    `If you are giving a final answer to the user and no tool is needed, use this exact envelope:`,
    FINAL_MODE_MARKER,
    "Your final answer text goes here.",
    FINAL_MODE_END_MARKER,
    "Rules for final answers:",
    `- Output ${FINAL_MODE_MARKER} first and ${FINAL_MODE_END_MARKER} last.`,
    "- Do not use markdown or JSON for final answers.",
    "- Do not mix normal prose before either marker.",
    "Available tools:",
    JSON.stringify(tools.map(t => ({
      name: t.function?.name,
      description: t.function?.description || "",
      parameters: t.function?.parameters || { type: "object" }
    })), null, 2)
  ].filter(Boolean).join("\n\n")
}

/**
 * Encode tool calls to text protocol
 */
function encodeToolCallsBlock(toolCalls: any[], flavor: "kimi" | "default" = "default"): string {
  const callBlocks = toolCalls.map(call => {
    const args = typeof call.function?.arguments === "string"
      ? call.function.arguments
      : JSON.stringify(call.function?.arguments || {})
    const payload = flavor === "kimi"
      ? { tool_name: call.function?.name, tool_input: JSON.parse(args) }
      : { name: call.function?.name, arguments: JSON.parse(args) }
    return `${CALL_MODE_MARKER}\n${JSON.stringify(payload, null, 2)}\n${CALL_MODE_END_MARKER}`
  })
  return `${TOOL_MODE_MARKER}\n${callBlocks.join("\n")}\n${TOOL_MODE_END_MARKER}`
}

/**
 * Encode tool result to text protocol
 */
function encodeToolResultBlock(message: any, flavor: "kimi" | "default" = "default", toolNames: string[] = []): string {
  const rawContent = contentPartsToText(message.content)
  const payload = {
    tool_call_id: message.tool_call_id || "",
    content: rawContent
  }
  return [
    "",
    `\`\`\`opencode-tool-result`,
    JSON.stringify(payload, null, 2),
    "```",
    "",
    "Continue from this tool result.",
    `Your next reply must use ${TOOL_MODE_MARKER} or ${FINAL_MODE_MARKER}.`,
    `For tool use, wrap CALL blocks inside ${TOOL_MODE_MARKER}.`,
  ].join("\n")
}

/**
 * Parse assistant text for tool calls or final content
 */
function parseBridgeAssistantText(text: string): { kind: "tool_calls" | "final" | "plain"; toolCalls?: any[]; content?: string } {
  const normalizedText = String(text || "")
  
  // Look for tool envelope
  const toolStart = normalizedText.indexOf(TOOL_MODE_MARKER)
  const toolEnd = normalizedText.indexOf(TOOL_MODE_END_MARKER)
  
  if (toolStart !== -1) {
    const toolContent = toolEnd !== -1 
      ? normalizedText.slice(toolStart + TOOL_MODE_MARKER.length, toolEnd)
      : normalizedText.slice(toolStart + TOOL_MODE_MARKER.length)
    
    // Extract CALL blocks
    const toolCalls: any[] = []
    const callRegex = /\[\[CALL\]\]([\s\S]*?)\[\[\/CALL\]\]/g
    let match
    while ((match = callRegex.exec(toolContent)) !== null) {
      const callText = match[1].trim()
      try {
        const payload = JSON.parse(callText)
        const name = payload.name || payload.tool_name
        const args = payload.arguments || payload.tool_input || {}
        if (name) {
          toolCalls.push({
            id: generateToolCallId(),
            type: "function",
            function: {
              name,
              arguments: typeof args === "string" ? args : JSON.stringify(args)
            }
          })
        }
      } catch {
        // Try to extract name from malformed JSON
        const nameMatch = callText.match(/"name"\s*:\s*"([^"]+)"/)
        if (nameMatch) {
          toolCalls.push({
            id: generateToolCallId(),
            type: "function",
            function: {
              name: nameMatch[1],
              arguments: "{}"
            }
          })
        }
      }
    }
    
    if (toolCalls.length > 0) {
      return { kind: "tool_calls", toolCalls }
    }
  }
  
  // Look for final envelope
  const finalStart = normalizedText.indexOf(FINAL_MODE_MARKER)
  const finalEnd = normalizedText.indexOf(FINAL_MODE_END_MARKER)
  
  if (finalStart !== -1) {
    const finalContent = finalEnd !== -1
      ? normalizedText.slice(finalStart + FINAL_MODE_MARKER.length, finalEnd)
      : normalizedText.slice(finalStart + FINAL_MODE_MARKER.length)
    return { kind: "final", content: finalContent.trim() }
  }
  
  // Plain text
  return { kind: "plain", content: normalizedText }
}

/**
 * NanoProxy OpenCode Plugin
 * 
 * This plugin transforms tool calls for NanoGPT models that have unreliable
 * native tool calling. It converts between OpenAI-style tool_calls and a
 * text-based protocol that works better with some models.
 */
export const NanoProxyPlugin: Plugin = async ({ client, project, directory, worktree, serverUrl, $ }) => {
  const hooks: Hooks = {}

  // Hook into message transformation to apply bridge protocol
  hooks["experimental.chat.messages.transform"] = async ({}, output) => {
    for (const item of output.messages) {
      const message = item.info as any
      const sessionId = message.sessionId || message.session_id
      
      // Check if this session has tools (bridge mode)
      if (!sessionId || !bridgeSessions.has(sessionId)) continue
      
      const tools = sessionTools.get(sessionId) || []
      const flavor = sessionModels.has(sessionId) 
        ? getBridgeFlavor(sessionModels.get(sessionId)!) 
        : "default"
      
      // Transform assistant messages with tool_calls to text protocol
      if (message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
        const bridgedContent = encodeToolCallsBlock(message.tool_calls, flavor)
        message.content = bridgedContent
        delete message.tool_calls
      }
      
      // Transform tool result messages
      if (message.role === "tool") {
        const toolNames = tools.map((t: any) => t.function?.name).filter(Boolean)
        const bridgedContent = encodeToolResultBlock(message, flavor, toolNames)
        message.role = "user"
        message.content = bridgedContent
        delete message.tool_call_id
        delete message.name
      }
    }
  }

  // Hook into system prompt transformation to inject bridge protocol
  hooks["experimental.chat.system.transform"] = async ({ sessionID, model }, output) => {
    if (bridgeSessions.has(sessionID) && sessionTools.has(sessionID)) {
      const tools = sessionTools.get(sessionID) || []
      const flavor = getBridgeFlavor(model?.id || "")
      const bridgeSystem = buildBridgeSystemMessage(tools, flavor)
      output.system.unshift(bridgeSystem)
    }
  }

  // Hook into chat params to detect tools and mark session as bridge mode
  hooks["chat.params"] = async ({ sessionID, agent, model, provider, message }, output) => {
    const msg = message as any
    const tools = msg?.tools
    
    if (tools && Array.isArray(tools) && tools.length > 0) {
      bridgeSessions.add(sessionID)
      sessionTools.set(sessionID, tools)
      sessionModels.set(sessionID, model?.id || "")
      
      // Cap temperature and top_p for bridge compliance
      if (typeof output.temperature !== "number" || output.temperature > 0.2) {
        output.temperature = 0.2
      }
      if (typeof output.topP !== "number" || output.topP > 0.3) {
        output.topP = 0.3
      }
    } else {
      // Clean up if no tools
      bridgeSessions.delete(sessionID)
      sessionTools.delete(sessionID)
      sessionModels.delete(sessionID)
    }
  }

  // Hook into text completion to parse streaming responses
  hooks["experimental.text.complete"] = async ({ sessionID, messageID, partID }, output) => {
    if (!bridgeSessions.has(sessionID)) {
      return // Not in bridge mode, pass through
    }
    
    // Get or create aggregate for this session
    let aggregate = sessionAggregates.get(sessionID)
    if (!aggregate) {
      aggregate = {
        reasoning: "",
        content: "",
        toolCalls: [],
        finishReason: null
      }
      sessionAggregates.set(sessionID, aggregate)
    }
    
    // Accumulate text
    const text = output.text || ""
    aggregate.content += text
    
    // Try to parse accumulated content for tool calls
    const parsed = parseBridgeAssistantText(aggregate.content)
    
    if (parsed.kind === "tool_calls" && parsed.toolCalls && parsed.toolCalls.length > 0) {
      // Clear the aggregate for next turn
      sessionAggregates.delete(sessionID)
      
      // Return empty text - tool_calls will be handled by message transform
      output.text = ""
    } else if (parsed.kind === "final") {
      // Final answer - pass through as-is
      output.text = parsed.content || text
      sessionAggregates.delete(sessionID)
    }
    // If kind is "plain", continue accumulating
  }

  // Clean up on session end
  hooks["event"] = async ({ event }) => {
    if (event.type === "session.end" || event.type === "session.idle") {
      const sessionId = (event as any).sessionId || (event as any).session_id
      if (sessionId) {
        sessionAggregates.delete(sessionId)
        bridgeSessions.delete(sessionId)
        sessionTools.delete(sessionId)
        sessionModels.delete(sessionId)
      }
    }
  }

  return hooks
}

export default NanoProxyPlugin