"use strict";

const assert = require("node:assert/strict");
const {
  buildBridgeResultFromText,
  buildChatCompletionFromBridge,
  buildSSEFromBridge,
  parseBridgeAssistantText,
  parseSSETranscript,
  transformRequestForBridge
} = require("./server");

function run() {
  const request = transformRequestForBridge({
    model: "zai-org/glm-5:thinking",
    tool_choice: "auto",
    tools: [
      {
        name: "write",
        description: "Write a file",
        parameters: {
          type: "object",
          properties: {
            filePath: { type: "string" },
            content: { type: "string" }
          },
          required: ["filePath", "content"]
        }
      }
    ],
    messages: [
      { role: "system", content: "system prompt" },
      { role: "user", content: "create a file" }
    ]
  });

  assert.equal(request.bridgeApplied, true);
  assert.equal(Array.isArray(request.rewritten.tools), false);
  assert.equal(request.rewritten.messages[1].role, "system");
  assert.match(request.rewritten.messages[1].content, /\[\[OPENCODE_TOOL\]\]/);
  assert.match(request.rewritten.messages[1].content, /\[\[\/OPENCODE_TOOL\]\]/);
  assert.match(request.rewritten.messages[1].content, /Invalid response example/);
  assert.equal(request.rewritten.temperature, 0.2);
  assert.equal(request.rewritten.top_p, 0.3);
  assert.equal(request.rewritten.messages[2].role, "user");
  assert.match(request.rewritten.messages[2].content, /Protocol requirements for your next reply/);
  assert.match(request.rewritten.messages[2].content, /first assistant turn/i);

  const requestWithToolResult = transformRequestForBridge({
    model: "zai-org/glm-5:thinking",
    tools: [
      {
        name: "write",
        description: "Write a file",
        parameters: { type: "object", properties: { filePath: { type: "string" } } }
      }
    ],
    messages: [
      { role: "user", content: "do it" },
      {
        role: "tool",
        tool_call_id: "call_123",
        content: "Wrote file successfully."
      }
    ]
  });
  const bridgedToolResultMessage = requestWithToolResult.rewritten.messages.find((msg) => msg.role === "user" && /opencode-tool-result/.test(msg.content || ""));
  assert.ok(bridgedToolResultMessage);
  assert.match(bridgedToolResultMessage.content, /Your next reply must be exactly one envelope/);
  assert.match(bridgedToolResultMessage.content, /Do not narrate the next step in plain text/);
  assert.match(bridgedToolResultMessage.content, /multiple items in tool_calls/);
  const bridgedUserMessage = requestWithToolResult.rewritten.messages.find((msg) => msg.role === "user" && /Protocol requirements for your next reply/.test(msg.content || ""));
  assert.ok(bridgedUserMessage);

  const parsedTool = parseBridgeAssistantText("```opencode-tool\n{\"tool_calls\":[{\"name\":\"write\",\"arguments\":{\"filePath\":\"a.txt\",\"content\":\"hi\"}}]}\n```");
  assert.equal(parsedTool.kind, "tool_calls");
  assert.equal(parsedTool.toolCalls[0].function.name, "write");
  assert.equal(parsedTool.toolCalls[0].function.arguments, JSON.stringify({ filePath: "a.txt", content: "hi" }));

  const parsedFinal = parseBridgeAssistantText("```opencode-final\n{\"content\":\"done\"}\n```");
  assert.equal(parsedFinal.kind, "final");
  assert.equal(parsedFinal.content, "done");

  const parsedWrappedTool = parseBridgeAssistantText(
    "I'll create it now.\n{\n  \"tool_calls\": [\n    {\n      \"name\": \"write\",\n      \"arguments\": {\n        \"filePath\": \"C:\\\\x\\\\a.txt\",\n        \"content\": \"hello\"\n      }\n    }\n  ]\n}"
  );
  assert.equal(parsedWrappedTool.kind, "tool_calls");
  assert.equal(parsedWrappedTool.toolCalls[0].function.name, "write");

  const parsedJsonFence = parseBridgeAssistantText(
    "```json\n{\"tool_call\":{\"name\":\"write\",\"arguments\":{\"filePath\":\"a.txt\",\"content\":\"x\"}}}\n```"
  );
  assert.equal(parsedJsonFence.kind, "tool_calls");
  assert.equal(parsedJsonFence.toolCalls[0].function.name, "write");

  const parsedFunctionWrapper = parseBridgeAssistantText(
    "{\"function\":{\"name\":\"read\",\"arguments\":{\"filePath\":\"b.txt\"}}}"
  );
  assert.equal(parsedFunctionWrapper.kind, "tool_calls");
  assert.equal(parsedFunctionWrapper.toolCalls[0].function.name, "read");

  const parsedArrayCalls = parseBridgeAssistantText(
    "[{\"name\":\"glob\",\"arguments\":{\"pattern\":\"src/**/*.js\"}}]"
  );
  assert.equal(parsedArrayCalls.kind, "tool_calls");
  assert.equal(parsedArrayCalls.toolCalls[0].function.name, "glob");

  const parsedAnswerWrapper = parseBridgeAssistantText(
    "```json\n{\"answer\":\"done\"}\n```"
  );
  assert.equal(parsedAnswerWrapper.kind, "final");
  assert.equal(parsedAnswerWrapper.content, "done");

  const parsedToolMarker = parseBridgeAssistantText(
    "[[OPENCODE_TOOL]]\n{\"tool_calls\":[{\"name\":\"write\",\"arguments\":{\"filePath\":\"a.txt\",\"content\":\"z\"}}]}\n[[/OPENCODE_TOOL]]"
  );
  assert.equal(parsedToolMarker.kind, "tool_calls");
  assert.equal(parsedToolMarker.toolCalls[0].function.name, "write");

  const parsedSingleBracketToolMarker = parseBridgeAssistantText(
    "[OPENCODE_TOOL]\n{\"tool_calls\":{\"name\":\"write\",\"arguments\":{\"filePath\":\"a.txt\",\"content\":\"z\"}}}\n[/OPENCODE_TOOL]"
  );
  assert.equal(parsedSingleBracketToolMarker.kind, "tool_calls");
  assert.equal(parsedSingleBracketToolMarker.toolCalls[0].function.name, "write");
  assert.match(parsedSingleBracketToolMarker.toolCalls[0].function.arguments, /a.txt/);

  const parsedLoosePluralToolMarker = parseBridgeAssistantText(
    "[ OPENCODE_TOOLS ]\n\"tool_calls\": {\"name\":\"write\",\"arguments\":{\"filePath\":\"b.txt\",\"content\":\"y\"}}\n[/OPENCODE_TOOL]"
  );
  assert.equal(parsedLoosePluralToolMarker.kind, "tool_calls");
  assert.equal(parsedLoosePluralToolMarker.toolCalls[0].function.name, "write");
  assert.match(parsedLoosePluralToolMarker.toolCalls[0].function.arguments, /b.txt/);

  const parsedFinalMarker = parseBridgeAssistantText(
    "[[OPENCODE_FINAL]]\nDone.\n[[/OPENCODE_FINAL]]"
  );
  assert.equal(parsedFinalMarker.kind, "final");
  assert.equal(parsedFinalMarker.content, "Done.");

  const parsedSingleBracketFinalMarker = parseBridgeAssistantText(
    "[OPENCODE_FINAL]\nDone.\n[/OPENCODE_FINAL]"
  );
  assert.equal(parsedSingleBracketFinalMarker.kind, "final");
  assert.equal(parsedSingleBracketFinalMarker.content, "Done.");

  const parsedLooseFinalMarker = parseBridgeAssistantText(
    "[ OPENCODE_FINAL ]\nDone.\n[/OPENCODE_FINAL]"
  );
  assert.equal(parsedLooseFinalMarker.kind, "final");
  assert.equal(parsedLooseFinalMarker.content, "Done.");

  const parsedCanonicalEnvelopeInsideProse = parseBridgeAssistantText(
    "I will do it now.\n[[OPENCODE_TOOL]]\n{\"tool_calls\":[{\"name\":\"read\",\"arguments\":{\"filePath\":\"c.txt\"}}]}\n[[/OPENCODE_TOOL]]\nThanks."
  );
  assert.equal(parsedCanonicalEnvelopeInsideProse.kind, "tool_calls");
  assert.equal(parsedCanonicalEnvelopeInsideProse.toolCalls[0].function.name, "read");

  const parsedMultiTool = parseBridgeAssistantText(
    "{\"tool_calls\":[{\"name\":\"read\",\"arguments\":{\"filePath\":\"a.txt\"}},{\"name\":\"write\",\"arguments\":{\"filePath\":\"b.txt\",\"content\":\"x\"}}]}"
  );
  assert.equal(parsedMultiTool.kind, "tool_calls");
  assert.equal(parsedMultiTool.toolCalls.length, 2);
  assert.equal(parsedMultiTool.toolCalls[0].function.name, "read");
  assert.equal(parsedMultiTool.toolCalls[1].function.name, "write");

  const parsedMultilineStringTool = parseBridgeAssistantText(
    "{\n  \"tool_calls\": [\n    {\n      \"name\": \"edit\",\n      \"arguments\": {\n        \"filePath\": \"C:\\\\x\\\\main.css\",\n        \"oldString\": \"line1\nline2\nline3\",\n        \"newString\": \"done\"\n      }\n    }\n  ]\n}"
  );
  assert.equal(parsedMultilineStringTool.kind, "tool_calls");
  assert.equal(parsedMultilineStringTool.toolCalls[0].function.name, "edit");
  assert.match(parsedMultilineStringTool.toolCalls[0].function.arguments, /line1\\nline2\\nline3/);

  const parsedMalformedTodoWrite = parseBridgeAssistantText(
    "[[OPENCODE_TOOL]]\n{\n  \"tool_calls\": [\n    {\n      \"name\": \"todowrite\",\n      \"arguments\": {\n        \"todos\": [\n          {\n            \"content\": \"First task\",\n            \"status\": \"in_progress\",\n            \"priority\": \"high\"\n          },\n          {\n            \"content\": \"Second task\",\n            \"status\": \"pending\",\n            \"priority\": \"high\"\n          },\n            \"content\": \"Third task\",\n            \"status\": \"pending\",\n            \"priority\": \"medium\"\n        ]\n      }\n    }\n  ]\n}\n[[/OPENCODE_TOOL]]"
  );
  assert.equal(parsedMalformedTodoWrite.kind, "tool_calls");
  assert.equal(parsedMalformedTodoWrite.toolCalls[0].function.name, "todowrite");
  assert.match(parsedMalformedTodoWrite.toolCalls[0].function.arguments, /First task/);
  assert.match(parsedMalformedTodoWrite.toolCalls[0].function.arguments, /Third task/);

  const transcript = parseSSETranscript([
    'data: {"id":"chatcmpl_1","object":"chat.completion.chunk","created":1,"model":"glm","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}',
    'data: {"id":"chatcmpl_1","object":"chat.completion.chunk","created":1,"model":"glm","choices":[{"index":0,"delta":{"reasoning":"think"},"finish_reason":null}]}',
    'data: {"id":"chatcmpl_1","object":"chat.completion.chunk","created":1,"model":"glm","choices":[{"index":0,"delta":{"content":"```opencode-tool\\n{\\"tool_calls\\":[{\\"name\\":\\"write\\",\\"arguments\\":{\\"filePath\\":\\"a.txt\\",\\"content\\":\\"hi\\"}}]}\\n```"},"finish_reason":null}]}',
    'data: {"id":"chatcmpl_1","object":"chat.completion.chunk","created":1,"model":"glm","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
    'data: [DONE]'
  ].join("\n"));
  assert.equal(transcript.reasoning, "think");
  assert.match(transcript.content, /opencode-tool/);

  const completion = buildChatCompletionFromBridge(transcript);
  assert.equal(completion.choices[0].finish_reason, "tool_calls");
  assert.equal(completion.choices[0].message.content, "");
  assert.equal(completion.choices[0].message.tool_calls[0].function.name, "write");

  const multiToolTranscript = parseSSETranscript([
    'data: {"id":"chatcmpl_2","object":"chat.completion.chunk","created":1,"model":"glm","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}',
    'data: {"id":"chatcmpl_2","object":"chat.completion.chunk","created":1,"model":"glm","choices":[{"index":0,"delta":{"content":"[[OPENCODE_TOOL]]\\n{\\"tool_calls\\":[{\\"name\\":\\"read\\",\\"arguments\\":{\\"filePath\\":\\"a.txt\\"}},{\\"name\\":\\"read\\",\\"arguments\\":{\\"filePath\\":\\"b.txt\\"}}]\\n[[/OPENCODE_TOOL]]"},"finish_reason":null}]}',
    'data: {"id":"chatcmpl_2","object":"chat.completion.chunk","created":1,"model":"glm","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
    'data: [DONE]'
  ].join("\n"));
  const multiToolCompletion = buildChatCompletionFromBridge(multiToolTranscript);
  assert.equal(multiToolCompletion.choices[0].finish_reason, "tool_calls");
  assert.equal(multiToolCompletion.choices[0].message.tool_calls.length, 2);
  assert.equal(multiToolCompletion.choices[0].message.tool_calls[0].function.name, "read");
  assert.equal(multiToolCompletion.choices[0].message.tool_calls[1].function.name, "read");

  const ignoresReasoningMarkers = buildBridgeResultFromText(
    "Normal final text.",
    "[[OPENCODE_TOOL]]\n{\"tool_calls\":[{\"name\":\"write\",\"arguments\":{\"filePath\":\"ignore.txt\",\"content\":\"x\"}}]}\n[[/OPENCODE_TOOL]]"
  );
  assert.equal(ignoresReasoningMarkers.kind, "final");
  assert.equal(ignoresReasoningMarkers.finishReason, "stop");
  assert.equal(ignoresReasoningMarkers.message.content, "Normal final text.");

  const stillUsesContentMarkers = buildBridgeResultFromText(
    "[[OPENCODE_TOOL]]\n{\"tool_calls\":[{\"name\":\"write\",\"arguments\":{\"filePath\":\"real.txt\",\"content\":\"x\"}}]}\n[[/OPENCODE_TOOL]]",
    "I should use [[OPENCODE_TOOL]] in content."
  );
  assert.equal(stillUsesContentMarkers.kind, "tool_calls");
  assert.equal(stillUsesContentMarkers.finishReason, "tool_calls");
  assert.equal(stillUsesContentMarkers.message.tool_calls[0].function.name, "write");

  const sse = buildSSEFromBridge(transcript);
  assert.match(sse, /"finish_reason":"tool_calls"/);
  assert.match(sse, /"tool_calls"/);

  const multiToolSse = buildSSEFromBridge(multiToolTranscript);
  assert.match(multiToolSse, /"tool_calls"/);
  assert.match(multiToolSse, /"index":0/);
  assert.match(multiToolSse, /"index":1/);

  process.stdout.write("selftest ok\n");
}

run();
