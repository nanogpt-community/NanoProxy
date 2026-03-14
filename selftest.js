"use strict";

const assert = require("node:assert/strict");
const {
  buildBridgeResultFromText,
  buildEmptyStopRecoveryRequest,
  buildChatCompletionFromBridge,
  buildSSEFromBridge,
  extractProgressiveToolCalls,
  isEmptyBridgeStopAggregate,
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
  assert.match(request.rewritten.messages[1].content, /\[\[CALL\]\]/);
  assert.match(request.rewritten.messages[1].content, /\[\[\/CALL\]\]/);
  assert.match(request.rewritten.messages[1].content, /Invalid response example/);
  assert.match(request.rewritten.messages[1].content, /Only two reply formats are valid/);
  assert.match(request.rewritten.messages[1].content, /Do not use legacy bracketed formats/);
  assert.match(request.rewritten.messages[1].content, /use the appropriate clarification tool instead of inventing requirements/);
  assert.match(request.rewritten.messages[1].content, /\[question\] \{ \.\.\. \}/);
  assert.equal(request.rewritten.temperature, 0.2);
  assert.equal(request.rewritten.top_p, 0.3);
  assert.equal(request.rewritten.messages[2].role, "user");
  assert.match(request.rewritten.messages[2].content, /Protocol requirements for your next reply/);
  assert.match(request.rewritten.messages[2].content, /prefer the appropriate clarification tool instead of guessing/);
  assert.match(request.rewritten.messages[2].content, /Do not use \[question\], \[write\], \[read\]/);
  assert.match(request.rewritten.messages[2].content, /concrete task/);
  assert.match(request.rewritten.messages[2].content, /generic greeting or conversation opener/);
  assert.match(request.rewritten.messages[2].content, /oldString with enough unique surrounding context/);
  assert.match(request.rewritten.messages[1].content, /oldString must be unique in the target file/);

  const kimiRequest = transformRequestForBridge({
    model: "moonshotai/kimi-k2.5:thinking",
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
      { role: "user", content: "create a file" }
    ]
  });
  assert.match(kimiRequest.rewritten.messages[0].content, /tool_name/);
  assert.match(kimiRequest.rewritten.messages[0].content, /tool_input/);
  assert.match(kimiRequest.rewritten.messages[1].content, /tool_name/);
  assert.match(kimiRequest.rewritten.messages[1].content, /tool_input/);
  assert.match(kimiRequest.rewritten.messages[0].content, /Emit exactly one CALL block per tool reply/);
  assert.match(kimiRequest.rewritten.messages[0].content, /Do not batch multiple tool calls in one reply/);
  assert.match(kimiRequest.rewritten.messages[0].content, /Do not emit \[\[CALL\]\] without first emitting \[\[OPENCODE_TOOL\]\]/);
  assert.doesNotMatch(kimiRequest.rewritten.messages[0].content, /Each CALL JSON object must use name and arguments/);
  assert.doesNotMatch(kimiRequest.rewritten.messages[0].content, /Valid multi-tool example/);
  assert.match(kimiRequest.rewritten.messages[1].content, /Do not output a second \[\[CALL\]\] until the first tool result comes back/);

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
  assert.match(bridgedToolResultMessage.content, /multiple CALL blocks/);
  assert.match(bridgedToolResultMessage.content, /Do not use legacy forms like \[question\]/);
  assert.match(bridgedToolResultMessage.content, /prefer the appropriate clarification tool instead of guessing/);
  assert.match(bridgedToolResultMessage.content, /oldString must include enough unique surrounding context/);
  const bridgedUserMessage = requestWithToolResult.rewritten.messages.find((msg) => msg.role === "user" && /Protocol requirements for your next reply/.test(msg.content || ""));
  assert.ok(bridgedUserMessage);

  const kimiToolResultRequest = transformRequestForBridge({
    model: "moonshotai/kimi-k2.5:thinking",
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
        tool_call_id: "call_kimi",
        content: "Wrote file successfully."
      }
    ]
  });
  const kimiBridgedToolResultMessage = kimiToolResultRequest.rewritten.messages.find((msg) => msg.role === "user" && /opencode-tool-result/.test(msg.content || ""));
  assert.ok(kimiBridgedToolResultMessage);
  assert.match(kimiBridgedToolResultMessage.content, /Do not batch multiple tool calls in one reply/);
  assert.match(kimiBridgedToolResultMessage.content, /Always include the outer \[\[OPENCODE_TOOL\]\] \.\.\. \[\[\/OPENCODE_TOOL\]\] wrapper/);

  const requestWithTypedToolResult = transformRequestForBridge({
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
        tool_call_id: "call_456",
        content: [
          { type: "text", text: "Wrote file successfully." },
          { type: "text", text: "\nNext file ready." }
        ]
      }
    ]
  });
  const bridgedTypedToolResultMessage = requestWithTypedToolResult.rewritten.messages.find((msg) => msg.role === "user" && /opencode-tool-result/.test(msg.content || ""));
  assert.ok(bridgedTypedToolResultMessage);
  assert.match(bridgedTypedToolResultMessage.content, /Wrote file successfully\./);
  assert.match(bridgedTypedToolResultMessage.content, /Next file ready\./);

  const requestWithTypedUserContent = transformRequestForBridge({
    model: "zai-org/glm-5:thinking",
    tools: [
      {
        name: "read",
        description: "Read a file",
        parameters: { type: "object", properties: { filePath: { type: "string" } } }
      }
    ],
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "I want a pie recipe" },
          { type: "text", text: "\n<system-reminder>plan</system-reminder>" }
        ]
      }
    ]
  });
  assert.match(requestWithTypedUserContent.rewritten.messages[2].content, /I want a pie recipe/);
  assert.match(requestWithTypedUserContent.rewritten.messages[2].content, /system-reminder/);

  assert.equal(isEmptyBridgeStopAggregate({
    reasoning: "",
    content: "",
    finishReason: "stop"
  }), true);
  assert.equal(isEmptyBridgeStopAggregate({
    reasoning: "thinking",
    content: "",
    finishReason: "stop"
  }), false);
  assert.equal(isEmptyBridgeStopAggregate({
    reasoning: "",
    content: "done",
    finishReason: "stop"
  }), false);

  const recoveryRequest = buildEmptyStopRecoveryRequest({
    messages: [
      { role: "system", content: "bridge" },
      { role: "user", content: "make a game" }
    ]
  });
  assert.equal(recoveryRequest.messages.at(-1).role, "user");
  assert.match(recoveryRequest.messages.at(-1).content, /Your previous reply was empty/);
  assert.match(recoveryRequest.messages.at(-1).content, /Do not return an empty response/);

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

  const parsedEmbeddedFinalWithLeadingJunk = parseBridgeAssistantText(
    "{\"content\":\"]\\nHello\"}"
  );
  assert.equal(parsedEmbeddedFinalWithLeadingJunk.kind, "final");
  assert.equal(parsedEmbeddedFinalWithLeadingJunk.content, "Hello");

  const parsedToolMarker = parseBridgeAssistantText(
    "[[OPENCODE_TOOL]]\n{\"tool_calls\":[{\"name\":\"write\",\"arguments\":{\"filePath\":\"a.txt\",\"content\":\"z\"}}]}\n[[/OPENCODE_TOOL]]"
  );
  assert.equal(parsedToolMarker.kind, "tool_calls");
  assert.equal(parsedToolMarker.toolCalls[0].function.name, "write");

  const parsedCallMarker = parseBridgeAssistantText(
    "[[OPENCODE_TOOL]]\n[[CALL]]\n{\"name\":\"write\",\"arguments\":{\"filePath\":\"a.txt\",\"content\":\"z\"}}\n[[/CALL]]\n[[/OPENCODE_TOOL]]"
  );
  assert.equal(parsedCallMarker.kind, "tool_calls");
  assert.equal(parsedCallMarker.toolCalls[0].function.name, "write");

  const parsedMultiCallMarker = parseBridgeAssistantText(
    "[[OPENCODE_TOOL]]\n[[CALL]]\n{\"name\":\"read\",\"arguments\":{\"filePath\":\"a.txt\"}}\n[[/CALL]]\n[[CALL]]\n{\"name\":\"read\",\"arguments\":{\"filePath\":\"b.txt\"}}\n[[/CALL]]\n[[/OPENCODE_TOOL]]"
  );
  assert.equal(parsedMultiCallMarker.kind, "tool_calls");
  assert.equal(parsedMultiCallMarker.toolCalls.length, 2);
  assert.equal(parsedMultiCallMarker.toolCalls[1].function.name, "read");

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

  const parsedBrokenToolMarker = parseBridgeAssistantText(
    "OPENCODE_TOOL]\n[CALL]\n{\"name\":\"write\",\"arguments\":{\"filePath\":\"c.txt\",\"content\":\"z\"}}\n[/CALL]\n[/OPENCODE_TOOL]"
  );
  assert.equal(parsedBrokenToolMarker.kind, "tool_calls");
  assert.equal(parsedBrokenToolMarker.toolCalls[0].function.name, "write");

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

  const parsedFinalWithLeadingJunk = parseBridgeAssistantText(
    "[[OPENCODE_FINAL]]\n]\nHello\n[[/OPENCODE_FINAL]]"
  );
  assert.equal(parsedFinalWithLeadingJunk.kind, "final");
  assert.equal(parsedFinalWithLeadingJunk.content, "Hello");

  const parsedFinalWithBrokenClosingMarker = parseBridgeAssistantText(
    "[[OPENCODE_FINAL]]\nHello\n[[/[OPENCODE_FINAL]"
  );
  assert.equal(parsedFinalWithBrokenClosingMarker.kind, "final");
  assert.equal(parsedFinalWithBrokenClosingMarker.content, "Hello");

  assert.equal(
    extractStreamableFinalContent("[[OPENCODE_FINAL]]\nHello\n[[/[OPENCODE_FINAL]"),
    "Hello\n"
  );
  assert.equal(
    extractStreamableFinalContent("Done.\n[[/[OPENCODE_FINAL]"),
    "Done.\n"
  );

  const parsedBracketNamedTool = parseBridgeAssistantText(
    '[question]\n{"questions":[{"question":"What do you want?","header":"Type","options":[{"label":"A","description":"desc"}]}]}'
  );
  assert.equal(parsedBracketNamedTool.kind, "tool_calls");
  assert.equal(parsedBracketNamedTool.toolCalls[0].function.name, "question");
  assert.match(parsedBracketNamedTool.toolCalls[0].function.arguments, /What do you want\?/);

  const parsedBracketNamedToolWithLeadingJunk = parseBridgeAssistantText(
    ']\n[question]\n{"questions":[{"question":"What do you want?","header":"Type","options":[{"label":"A","description":"desc"}]}]}'
  );
  assert.equal(parsedBracketNamedToolWithLeadingJunk.kind, "tool_calls");
  assert.equal(parsedBracketNamedToolWithLeadingJunk.toolCalls[0].function.name, "question");

  const parsedLegacyCallWithParams = parseBridgeAssistantText(
    "[OPENCODE_TOOL]\n[CALL]\n{\"tool\":\"explorer\",\"params\":{\"pattern\":\"**/*.{ts,tsx}\"},\"purpose\":\"Find TS files\"}\n[/CALL]\n[/OPENCODE_TOOL]"
  );
  assert.equal(parsedLegacyCallWithParams.kind, "tool_calls");
  assert.equal(parsedLegacyCallWithParams.toolCalls[0].function.name, "explorer");
  assert.match(parsedLegacyCallWithParams.toolCalls[0].function.arguments, /Find TS files/);

  const parsedLegacyWriteWithSnakeCaseParams = parseBridgeAssistantText(
    "[[OPENCODE_TOOL]]\n[[CALL]]\n{\"tool\":\"write\",\"params\":{\"file_path\":\"boss.js\",\"content\":\"export const boss = true;\"}}\n[[/CALL]]\n[[/OPENCODE_TOOL]]"
  );
  assert.equal(parsedLegacyWriteWithSnakeCaseParams.kind, "tool_calls");
  assert.equal(parsedLegacyWriteWithSnakeCaseParams.toolCalls[0].function.name, "write");
  assert.equal(
    parsedLegacyWriteWithSnakeCaseParams.toolCalls[0].function.arguments,
    JSON.stringify({ filePath: "boss.js", content: "export const boss = true;" })
  );

  const parsedLegacyWriteWithTopLevelFields = parseBridgeAssistantText(
    "[[OPENCODE_TOOL]]\n[[CALL]]\n{\"tool\":\"write\",\"path\":\"boss.js\",\"content\":\"export const boss = true;\"}\n[[/CALL]]\n[[/OPENCODE_TOOL]]"
  );
  assert.equal(parsedLegacyWriteWithTopLevelFields.kind, "tool_calls");
  assert.equal(parsedLegacyWriteWithTopLevelFields.toolCalls[0].function.name, "write");
  assert.equal(
    parsedLegacyWriteWithTopLevelFields.toolCalls[0].function.arguments,
    JSON.stringify({ filePath: "boss.js", content: "export const boss = true;" })
  );

  const parsedLegacyWriteWithToolInput = parseBridgeAssistantText(
    "[[OPENCODE_TOOL]]\n[[CALL]]\n{\"tool_name\":\"write\",\"tool_input\":{\"file_path\":\"boss.js\",\"content\":\"export const boss = true;\"}}\n[[/CALL]]\n[[/OPENCODE_TOOL]]"
  );
  assert.equal(parsedLegacyWriteWithToolInput.kind, "tool_calls");
  assert.equal(parsedLegacyWriteWithToolInput.toolCalls[0].function.name, "write");
  assert.equal(
    parsedLegacyWriteWithToolInput.toolCalls[0].function.arguments,
    JSON.stringify({ filePath: "boss.js", content: "export const boss = true;" })
  );

  const parsedShellAliasCall = parseBridgeAssistantText(
    "[[OPENCODE_TOOL]]\n[[CALL]]\n{\"name\":\"shell\",\"arguments\":{\"command\":\"ls -la\"}}\n[[/CALL]]\n[[/OPENCODE_TOOL]]"
  );
  assert.equal(parsedShellAliasCall.kind, "tool_calls");
  assert.equal(parsedShellAliasCall.toolCalls[0].function.name, "bash");

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

  const progressiveOne = extractProgressiveToolCalls(
    '[[OPENCODE_TOOL]]\n{"tool_calls":[{"name":"read","arguments":{"filePath":"a.txt"}}'
  );
  assert.equal(progressiveOne.length, 1);
  assert.equal(progressiveOne[0].function.name, "read");

  const progressiveTwo = extractProgressiveToolCalls(
    '[[OPENCODE_TOOL]]\n{"tool_calls":[{"name":"read","arguments":{"filePath":"a.txt"}},{"name":"read","arguments":{"filePath":"b.txt"}}'
  );
  assert.equal(progressiveTwo.length, 2);
  assert.equal(progressiveTwo[1].function.name, "read");

  const progressiveCallMarkers = extractProgressiveToolCalls(
    '[[OPENCODE_TOOL]]\n[[CALL]]\n{"name":"read","arguments":{"filePath":"a.txt"}}\n[[/CALL]]\n[[CALL]]\n{"name":"read","arguments":{"filePath":"b.txt"}}'
  );
  assert.equal(progressiveCallMarkers.length, 1);
  assert.equal(progressiveCallMarkers[0].function.name, "read");

  const progressiveClosedCallMarkers = extractProgressiveToolCalls(
    '[[OPENCODE_TOOL]]\n[[CALL]]\n{"name":"read","arguments":{"filePath":"a.txt"}}\n[[/CALL]]\n[[CALL]]\n{"name":"read","arguments":{"filePath":"b.txt"}}\n[[/CALL]]'
  );
  assert.equal(progressiveClosedCallMarkers.length, 2);
  assert.equal(progressiveClosedCallMarkers[1].function.name, "read");

  const progressiveToolEndImplicitClose = extractProgressiveToolCalls(
    '[[OPENCODE_TOOL]]\n[[CALL]]\n{"name":"write","arguments":{"filePath":"player.js","content":"player"}}\n[[/CALL]]\n[[CALL]]\n{"name":"write","arguments":{"filePath":"enemy.js","content":"enemy"}}\n[[/OPENCODE_TOOL]]'
  );
  assert.equal(progressiveToolEndImplicitClose.length, 2);
  assert.equal(progressiveToolEndImplicitClose[0].function.arguments, '{"filePath":"player.js","content":"player"}');
  assert.equal(progressiveToolEndImplicitClose[1].function.arguments, '{"filePath":"enemy.js","content":"enemy"}');

  const progressiveCallOnlyMarkers = extractProgressiveToolCalls(
    '[[CALL]]\n{"tool_name":"read","tool_input":{"filePath":"a.txt"}}\n[[/CALL]]\n[[CALL]]\n{"tool_name":"read","tool_input":{"filePath":"b.txt"}}'
  );
  assert.equal(progressiveCallOnlyMarkers.length, 1);
  assert.equal(progressiveCallOnlyMarkers[0].function.name, "read");

  const progressiveMalformedCallCloser = extractProgressiveToolCalls(
    '[[CALL]]\n{"tool_name":"read","tool_input":{"filePath":"a.txt"}}\n/CALL]]'
  );
  assert.equal(progressiveMalformedCallCloser.length, 1);
  assert.equal(progressiveMalformedCallCloser[0].function.name, "read");

  const parsedCallOnlyMarkers = parseBridgeAssistantText(
    '[[CALL]]\n{"tool_name":"read","tool_input":{"filePath":"a.txt"}}\n[[/CALL]]\n[[CALL]]\n{"tool_name":"read","tool_input":{"filePath":"b.txt"}}\n[[/CALL]]'
  );
  assert.equal(parsedCallOnlyMarkers.kind, "tool_calls");
  assert.equal(parsedCallOnlyMarkers.toolCalls.length, 2);
  assert.equal(parsedCallOnlyMarkers.toolCalls[1].function.name, "read");

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

  const finalResultWithLeadingJunk = buildBridgeResultFromText("]\nHello", "");
  assert.equal(finalResultWithLeadingJunk.kind, "final");
  assert.equal(finalResultWithLeadingJunk.message.content, "Hello");

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
