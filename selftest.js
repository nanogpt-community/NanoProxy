"use strict";

const assert = require("node:assert/strict");
process.env.BRIDGE_PROTOCOL = 'xml';

const core = require("./src/core.js");

// ---- Test: transformRequestForXmlBridge ----
(function testTransformRequestForXmlBridge() {
  const body = {
    model: "test-model",
    messages: [{ role: "user", content: "Fix the failing test" }],
    tools: [{
      type: "function",
      function: {
        name: "edit_file",
        description: "Edit a file",
        parameters: {
          type: "object",
          properties: {
            filePath: { type: "string", description: "Path" },
            newString: { type: "string", description: "Replacement" }
          },
          required: ["filePath", "newString"]
        }
      }
    }]
  };
  const transformed = core.transformRequestForXmlBridge(body);
  assert.equal(transformed.bridgeApplied, true);
  assert.equal(Array.isArray(transformed.rewritten.tools), false);
  assert.deepEqual(transformed.toolNames, ["edit_file"]);
  // System prompt should show the tool-name-as-tag format
  assert.match(transformed.rewritten.messages[0].content, /<edit_file>/);
  assert.match(transformed.rewritten.messages[0].content, /<filePath>/);
  assert.match(transformed.rewritten.messages[0].content, /<\/edit_file>/);
  assert.match(transformed.rewritten.messages[0].content, /<open>I will use edit_file now\.<\/open>/);
  assert.match(transformed.rewritten.messages[0].content, /begin with a brief user-facing line inside <open>/);
  assert.match(transformed.rewritten.messages[0].content, /Never return an empty tool-enabled response/);
  console.log("  PASS: transformRequestForXmlBridge");
})();

// ---- Test: parallel requests get a batched example in the prompt ----
(function testParallelPromptExample() {
  const body = {
    model: "test-model",
    parallel_tool_calls: true,
    messages: [{ role: "user", content: "Check both files" }],
    tools: [
      {
        type: "function",
        function: {
          name: "read_file",
          description: "Read a file",
          parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }
        }
      },
      {
        type: "function",
        function: {
          name: "search_files",
          description: "Search files",
          parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }
        }
      }
    ]
  };

  const transformed = core.transformRequestForXmlBridge(body);
  const prompt = transformed.rewritten.messages[0].content;
  assert.match(prompt, /Batching a small independent check/);
  assert.match(prompt, /<open>I will check both items now, then continue after the results\.<\/open>/);
  assert.match(prompt, /keep batches small and clearly independent/);
  assert.match(prompt, /Do not try to complete an entire multi-step task in one huge response/);
  console.log("  PASS: parallel prompt example");
})();

// ---- Test: encodeAssistantToolCallsMessage ----
(function testAssistantHistoryEncoding() {
  const encoded = core.encodeAssistantToolCallsMessage({
    role: "assistant",
    content: "I found the issue.",
    tool_calls: [{
      id: "call_1",
      type: "function",
      function: {
        name: "bash",
        arguments: JSON.stringify({ command: "npm test", timeout: 30000 })
      }
    }]
  }, ["bash"]);
  assert.match(encoded, /I found the issue\./);
  assert.match(encoded, /<bash>/);
  assert.match(encoded, /<command>/);
  assert.match(encoded, /npm test/);
  assert.match(encoded, /<\/bash>/);
  console.log("  PASS: encodeAssistantToolCallsMessage");
})();

// ---- Test: parseXmlAssistantText with tool calls ----
(function testParseXmlAssistantTextToolCall() {
  const toolNames = ["edit_file"];
  const parsed = core.parseXmlAssistantText(`
I found the failing test. I will patch it.

<edit_file>
<filePath>tests/test.js</filePath>
<newString>console.log('ok')</newString>
</edit_file>`, toolNames);
  assert.equal(parsed.kind, "tool_calls");
  assert.match(parsed.content, /I found the failing test/);
  const call = parsed.toolCalls[0];
  assert.equal(call.function.name, "edit_file");
  assert.equal(JSON.parse(call.function.arguments).filePath, "tests/test.js");
  assert.equal(JSON.parse(call.function.arguments).newString, "console.log('ok')");
  console.log("  PASS: parseXmlAssistantText (tool_calls)");
})();

// ---- Test: JSON-style escaped string arguments are decoded for string params ----
(function testJsonStyleEscapesDecode() {
  const tools = [{ name: "write", args: [{ name: "filePath", type: "string" }, { name: "content", type: "string" }] }];
  const parsed = core.parseXmlAssistantText(`
<write>
<filePath>C:\\repo\\file.py</filePath>
<content>line1\nline2\nprint(\"ok\")</content>
</write>`, tools);
  assert.equal(parsed.kind, "tool_calls");
  const args = JSON.parse(parsed.toolCalls[0].function.arguments);
  assert.equal(args.filePath, "C:\repo\file.py");
  assert.equal(args.content, 'line1\nline2\nprint("ok")');
  console.log("  PASS: JSON-style escaped string args decode");
})();

// ---- Test: parseXmlAssistantText final (no tool calls) ----
(function testParseXmlAssistantTextFinal() {
  const parsed = core.parseXmlAssistantText(`All tests pass now.`, ["edit_file"]);
  assert.equal(parsed.kind, "final");
  assert.equal(parsed.content, "All tests pass now.");
  console.log("  PASS: parseXmlAssistantText (final)");
})();

// ---- Test: reasoning-only empty final turn is invalid when tools are enabled ----
(function testInvalidBridgeCompletion() {
  const result = core.buildBridgeResultFromText("", "I should inspect the file first.", ["read_file"]);
  assert.equal(result.kind, "invalid");
  assert.equal(result.error.code, "invalid_bridge_completion");
  console.log("  PASS: invalid bridge completion");
})();

// ---- Test: recover XML tool calls misplaced into reasoning ----
(function testRecoverToolCallFromReasoning() {
  const result = core.buildBridgeResultFromText("", `Let me fix it now.\n\n<edit>\n<filePath>src/app.py</filePath>\n<oldString>bad</oldString>\n<newString>good</newString>\n</edit>`, [{ name: "edit", args: [{ name: "filePath", type: "string" }, { name: "oldString", type: "string" }, { name: "newString", type: "string" }] }]);
  assert.equal(result.kind, "tool_calls");
  assert.equal(result.message.tool_calls[0].function.name, "edit");
  assert.equal(result.message.reasoning_content, "Let me fix it now.");
  const args = JSON.parse(result.message.tool_calls[0].function.arguments);
  assert.equal(args.filePath, "src/app.py");
  assert.equal(args.oldString, "bad");
  assert.equal(args.newString, "good");
  console.log("  PASS: recover tool call from reasoning");
})();

// ---- Test: JSON completion translation ----
(function testJsonCompletionTranslation() {
  const toolNames = ["read_file"];
  const aggregate = {
    id: "chatcmpl_test",
    model: "test-model",
    created: 123,
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    reasoning: "Reasoning here",
    content: `I found it.\n<read_file>\n<path>README.md</path>\n</read_file>`
  };
  const translated = core.buildChatCompletionFromXmlBridge(aggregate, toolNames);
  assert.equal(translated.choices[0].finish_reason, "tool_calls");
  assert.match(translated.choices[0].message.content, /I found it/);
  assert.equal(translated.choices[0].message.tool_calls[0].function.name, "read_file");
  console.log("  PASS: JSON completion translation");
})();

// ---- Test: SSE translation ----
(function testSseTranslation() {
  const toolNames = ["bash"];
  const aggregate = {
    id: "chatcmpl_stream",
    model: "test-model",
    created: 456,
    usage: null,
    reasoning: "Thinking",
    content: `Running tests now.\n<bash>\n<command>npm test</command>\n</bash>`
  };
  const translated = core.buildSSEFromXmlBridge(aggregate, toolNames);
  assert.match(translated, /"reasoning":"Thinking"/);
  assert.match(translated, /Running tests now/);
  assert.match(translated, /"tool_calls"/);
  assert.match(translated, /"finish_reason":"tool_calls"/);
  console.log("  PASS: SSE translation");
})();

// ---- Test: multiple tool calls ----
(function testMultipleToolCalls() {
  const toolNames = ["read_file"];
  const parsed = core.parseXmlAssistantText(`
Let me read both files.

<read_file>
<path>src/app.js</path>
</read_file>

<read_file>
<path>src/index.js</path>
</read_file>`, toolNames);
  assert.equal(parsed.kind, "tool_calls");
  assert.equal(parsed.toolCalls.length, 2);
  assert.equal(parsed.toolCalls[0].function.name, "read_file");
  assert.equal(JSON.parse(parsed.toolCalls[0].function.arguments).path, "src/app.js");
  assert.equal(JSON.parse(parsed.toolCalls[1].function.arguments).path, "src/index.js");
  console.log("  PASS: multiple tool calls");
})();

// ---- Test: preserve emitted tool call order ----
(function testToolCallOrderPreserved() {
  const tools = [
    { name: "bash", args: [{ name: "command", type: "string" }] },
    { name: "read_file", args: [{ name: "path", type: "string" }] }
  ];
  const parsed = core.parseXmlAssistantText(`
<read_file>
<path>src/app.js</path>
</read_file>

<bash>
<command>echo hi</command>
</bash>`, tools);
  assert.equal(parsed.kind, "tool_calls");
  assert.deepEqual(parsed.toolCalls.map((call) => call.function.name), ["read_file", "bash"]);
  console.log("  PASS: tool call order preserved");
})();

// ---- Test: unrelated XML tags are ignored ----
(function testUnrelatedXmlIgnored() {
  const toolNames = ["read_file"];
  const parsed = core.parseXmlAssistantText(`
<thinking>I should check the file first</thinking>

<task type="analyze">do stuff</task>

<read_file>
<path>src/app.js</path>
</read_file>`, toolNames);
  assert.equal(parsed.kind, "tool_calls");
  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0].function.name, "read_file");
  // The unrelated XML should remain in the content
  assert.match(parsed.content, /thinking/);
  console.log("  PASS: unrelated XML tags ignored");
})();

// ---- Test: Parse parameters from XML attributes ----
(function testAttributeParameters() {
  const toolNames = ["task"];
  const parsed = core.parseXmlAssistantText(`
<task description="Explore codebase structure" prompt="Find files" subagent_type="explore"></task>
  `, toolNames);
  
  assert.equal(parsed.kind, "tool_calls");
  assert.equal(parsed.toolCalls.length, 1);
  const args = JSON.parse(parsed.toolCalls[0].function.arguments);
  assert.equal(args.description, "Explore codebase structure");
  assert.equal(args.prompt, "Find files");
  assert.equal(args.subagent_type, "explore");
  console.log("  PASS: parameters from XML attributes");
})();

// ---- Test: dotted and dashed attribute names survive generic parsing ----
(function testExtendedAttributeNames() {
  const toolNames = ["task"];
  const parsed = core.parseXmlAssistantText(`
<task trace.id="abc123" subagent-type="explore"></task>
  `, toolNames);

  assert.equal(parsed.kind, "tool_calls");
  const args = JSON.parse(parsed.toolCalls[0].function.arguments);
  assert.equal(args["trace.id"], "abc123");
  assert.equal(args["subagent-type"], "explore");
  console.log("  PASS: extended attribute names");
})();

// ---- Test: Mixed attributes and child tags ----
(function testMixedParameters() {
  const toolNames = ["task"];
  const parsed = core.parseXmlAssistantText(`
<task subagent_type="explore" description="Search">
<prompt>Detailed instructions here</prompt>
</task>
  `, toolNames);
  
  assert.equal(parsed.kind, "tool_calls");
  const args = JSON.parse(parsed.toolCalls[0].function.arguments);
  assert.equal(args.subagent_type, "explore");
  assert.equal(args.description, "Search");
  assert.equal(args.prompt, "Detailed instructions here");
  console.log("  PASS: mixed attributes and child tags");
})();

// ---- Test: camelCase attribute parameters ----
(function testCamelCaseAttributeParameters() {
  const tools = [{ name: "edit_file", args: [{ name: "filePath", type: "string" }] }];
  const parsed = core.parseXmlAssistantText(`
<edit_file filePath="src/app.js"></edit_file>
  `, tools);

  assert.equal(parsed.kind, "tool_calls");
  assert.equal(JSON.parse(parsed.toolCalls[0].function.arguments).filePath, "src/app.js");
  console.log("  PASS: camelCase attribute parameters");
})();

// ---- Test: object/array parameters preserve raw JSON text ----
(function testStructuredArgumentPassThrough() {
  const tools = [{
    name: "edit_file",
    args: [{ name: "changes", type: "array" }]
  }];
  const parsed = core.parseXmlAssistantText(`
<edit_file>
<changes>[{"path":"src/app.js","old":"a","new":"b"}]</changes>
</edit_file>
  `, tools);

  assert.equal(parsed.kind, "tool_calls");
  assert.equal(JSON.parse(parsed.toolCalls[0].function.arguments).changes[0].path, "src/app.js");
  console.log("  PASS: structured argument passthrough");
})();

// ---- Test: <open> tags are stripped from visible content ----
(function testOpenTagsStripped() {
  const tools = [{ name: "bash", args: [{ name: "command", type: "string" }] }];
  const parsed = core.parseXmlAssistantText(`
<open>I will run the tests now.</open>
<bash>
<command>npm test</command>
</bash>`, tools);

  assert.equal(parsed.kind, "tool_calls");
  assert.equal(parsed.content, "I will run the tests now.");

  const aggregate = {
    id: "chatcmpl_open",
    model: "test-model",
    created: 789,
    usage: null,
    reasoning: "",
    content: `<open>I will run the tests now.</open>\n<bash><command>npm test</command></bash>`
  };
  const translated = core.buildChatCompletionFromXmlBridge(aggregate, tools);
  assert.equal(translated.choices[0].message.content, "I will run the tests now.");
  console.log("  PASS: open tags stripped");
})();

// ---- Test: Streaming XML Parser ----
(function testStreamingXmlParser() {
  const toolNames = ["bash", "read_file"];
  
  let contentEmitted = "";
  const toolsEmitted = [];
  
  const parser = new core.StreamingXmlParser(toolNames, {
    onContent: (text) => contentEmitted += text,
    onToolCall: (call, idx) => toolsEmitted.push({ call, idx })
  });

  const stream = "Here is the issue.\n<ba";
  parser.feed(stream);
  assert.equal(contentEmitted, "Here is the issue.\n");
  
  parser.feed("sh><command>echo hi</comm");
  assert.equal(contentEmitted, "Here is the issue.\n");
  assert.equal(toolsEmitted.length, 0); // Still buffering
  
  parser.feed("and></bash>Done.");
  assert.equal(contentEmitted, "Here is the issue.\nDone.");
  assert.equal(toolsEmitted.length, 1);
  assert.equal(toolsEmitted[0].call.function.name, "bash");
  assert.equal(JSON.parse(toolsEmitted[0].call.function.arguments).command, "echo hi");
  assert.equal(toolsEmitted[0].idx, 0);

  // Test false alarm
  parser.feed("<bastard>Not a tool</bastard>");
  // Wait, parser emits instantly on false alarm
  assert.match(contentEmitted, /<bastard>Not a tool<\/bastard>/);

  console.log("  PASS: StreamingXmlParser");
})();

// ---- Test: StreamingXmlParser recognizes tool tags with tab-separated attrs ----
(function testStreamingXmlParserWhitespaceAttrs() {
  const tools = [{ name: "bash", args: [{ name: "command", type: "string" }] }];
  let content = "";
  const calls = [];
  const parser = new core.StreamingXmlParser(tools, {
    onContent: (text) => content += text,
    onToolCall: (call) => calls.push(call)
  });

  parser.feed("Before\n<bash\tdata-x=\"1\"><command>echo hi</command></bash>\nAfter");
  parser.flush();

  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(calls[0].function.arguments).command, "echo hi");
  assert.match(content, /Before/);
  assert.match(content, /After/);
  console.log("  PASS: StreamingXmlParser whitespace attrs");
})();

// ---- Test: Plugin install is idempotent ----
async function testPluginIdempotentInstall() {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async function testFetch() {
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const mod = await import('file:///c:/Debug%20attempt/Nano_Proxy/src/plugin.mjs');
    await mod.NanoProxyPlugin();
    const once = globalThis.fetch;
    await mod.NanoProxyPlugin();
    const twice = globalThis.fetch;
    assert.notEqual(once, originalFetch);
    assert.equal(once, twice);
    console.log('  PASS: plugin install idempotent');
  } finally {
    globalThis.fetch = originalFetch;
    delete globalThis[Symbol.for('nanoproxy.fetchPatch')];
  }
}

// ---- Test: Plugin streaming returns response immediately ----
async function testPluginStreamingReturnsImmediately() {
  const originalFetch = globalThis.fetch;
  try {
    const mod = await import('file:///c:/Debug%20attempt/Nano_Proxy/src/plugin.mjs');
    const upstream = new TransformStream();
    globalThis.fetch = async function testFetch() {
      return new Response(upstream.readable, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' }
      });
    };

    await mod.NanoProxyPlugin();

    const requestBody = {
      model: 'glm-5',
      stream: true,
      messages: [{ role: 'user', content: 'hello' }],
      tools: [{
        type: 'function',
        function: {
          name: 'bash',
          parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] }
        }
      }]
    };

    const fetchPromise = globalThis.fetch('https://nano-gpt.com/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(requestBody)
    });

    const response = await Promise.race([
      fetchPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('plugin fetch did not return promptly')), 250))
    ]);

    assert.equal(response instanceof Response, true);
    assert.match(response.headers.get('content-type') || '', /text\u002fevent-stream/i);
    await upstream.writable.abort();
    console.log('  PASS: plugin streaming returns immediately');
  } finally {
    globalThis.fetch = originalFetch;
    delete globalThis[Symbol.for('nanoproxy.fetchPatch')];
  }
}


function withBridgeProtocol(protocol, fn) {
  const previous = process.env.BRIDGE_PROTOCOL;
  if (protocol == null) delete process.env.BRIDGE_PROTOCOL;
  else process.env.BRIDGE_PROTOCOL = protocol;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.BRIDGE_PROTOCOL;
    else process.env.BRIDGE_PROTOCOL = previous;
  }
}

// ---- Test: object bridge request rewrite ----
(function testTransformRequestForObjectBridge() {
  withBridgeProtocol('object', () => {
    const body = {
      model: 'test-model',
      messages: [{ role: 'user', content: 'Fix the file' }],
      tools: [{
        type: 'function',
        function: {
          name: 'todowrite',
          description: 'Write todos',
          parameters: {
            type: 'object',
            properties: {
              todos: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    content: { type: 'string' },
                    status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] }
                  },
                  required: ['content', 'status']
                }
              }
            },
            required: ['todos']
          }
        }
      }]
    };
    const transformed = core.transformRequestForBridge(body);
    assert.equal(transformed.protocol, 'object');
    assert.equal(transformed.bridgeApplied, true);
    assert.ok(!('tools' in transformed.rewritten));
    assert.match(transformed.rewritten.messages[0].content, /Structured Turn Contract/);
    assert.match(transformed.rewritten.messages[0].content, /"mode"/);
    assert.match(transformed.rewritten.messages[0].content, /"items"/);
    assert.match(transformed.rewritten.messages[0].content, /"content"/);
    assert.match(transformed.rewritten.messages[0].content, /"status"/);
  });
  console.log('  PASS: transformRequestForObjectBridge');
})();

// ---- Test: object bridge result translation ----
(function testBuildBridgeResultFromObjectText() {
  withBridgeProtocol('object', () => {
    const result = core.buildBridgeResultFromText(JSON.stringify({
      v: 1,
      mode: 'tool',
      message: 'I will patch the file now.',
      tool_calls: [{ name: 'edit', arguments: { filePath: 'src/app.js', oldString: 'bad', newString: 'good' } }]
    }), '', [{ name: 'edit' }]);
    assert.equal(result.kind, 'tool_calls');
    assert.equal(result.message.content, 'I will patch the file now.');
    assert.equal(result.message.tool_calls[0].function.name, 'edit');
    assert.deepEqual(JSON.parse(result.message.tool_calls[0].function.arguments), { filePath: 'src/app.js', oldString: 'bad', newString: 'good' });
  });
  console.log('  PASS: buildBridgeResultFromObjectText');
})();

// ---- Test: StreamingObjectParser emits message and tool calls ----
(function testStreamingObjectParser() {
  withBridgeProtocol('object', () => {
    let contentEmitted = '';
    const calls = [];
    const parser = core.createStreamingBridgeParser([{ name: 'read' }], {
      onContent: (text) => contentEmitted += text,
      onToolCall: (call, idx) => calls.push({ call, idx })
    });
    parser.feed('{"v":1,"mode":"tool","message":"I will inspect now.","tool_calls":[{"name":"read","arguments":{"path":"README.md"}}]}');
    parser.flush();
    assert.equal(contentEmitted, 'I will inspect now.');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].idx, 0);
    assert.equal(calls[0].call.function.name, 'read');
    assert.deepEqual(JSON.parse(calls[0].call.function.arguments), { path: 'README.md' });
  });
  console.log('  PASS: StreamingObjectParser');
})();

// ---- Test: object bridge rejects plain prose without a turn object ----
(function testBuildBridgeResultFromPlainProseIsInvalidInObjectMode() {
  withBridgeProtocol('object', () => {
    const result = core.buildBridgeResultFromText('I will start by creating the project structure.', 'reasoning here', [{ name: 'bash' }]);
    assert.equal(result.kind, 'invalid');
    assert.equal(result.error.code, 'missing_bridge_object_turn');
  });
  console.log('  PASS: buildBridgeResultFromPlainProseIsInvalidInObjectMode');
})();
// ---- Test: object bridge accepts flattened tool-call arguments ----
(function testBuildBridgeResultFromFlattenedObjectText() {
  withBridgeProtocol('object', () => {
    const result = core.buildBridgeResultFromText(JSON.stringify({
      v: 1,
      mode: 'tool',
      message: 'Creating folders now.',
      tool_calls: [{ name: 'bash', command: 'mkdir -p src tests', description: 'Create folders' }]
    }), '', [{ name: 'bash' }]);
    assert.equal(result.kind, 'tool_calls');
    assert.equal(result.message.content, 'Creating folders now.');
    assert.equal(result.message.tool_calls[0].function.name, 'bash');
    assert.deepEqual(JSON.parse(result.message.tool_calls[0].function.arguments), {
      command: 'mkdir -p src tests',
      description: 'Create folders'
    });
  });
  console.log('  PASS: buildBridgeResultFromFlattenedObjectText');
})();

// ---- Test: object bridge accepts modest multi-tool batches ----
(function testBuildBridgeResultFromObjectTextThreeTools() {
  withBridgeProtocol('object', () => {
    const result = core.buildBridgeResultFromText(JSON.stringify({
      v: 1,
      mode: 'tool',
      message: 'Creating project structure now.',
      tool_calls: [
        { name: 'bash', arguments: { command: 'mkdir -p project/tests', description: 'Create directories' } },
        { name: 'write', arguments: { filePath: 'project/__init__.py', content: '' } },
        { name: 'write', arguments: { filePath: 'project/tests/__init__.py', content: '' } }
      ]
    }), '', [{ name: 'bash' }, { name: 'write' }]);
    assert.equal(result.kind, 'tool_calls');
    assert.equal(result.message.tool_calls.length, 3);
    assert.equal(result.message.tool_calls[0].function.name, 'bash');
    assert.equal(result.message.tool_calls[1].function.name, 'write');
    assert.equal(result.message.tool_calls[2].function.name, 'write');
  });
  console.log('  PASS: buildBridgeResultFromObjectText three tools');
})();
// ---- Test: StreamingObjectParser accepts flattened tool-call arguments ----
(function testStreamingObjectParserFlattened() {
  withBridgeProtocol('object', () => {
    let contentEmitted = '';
    const calls = [];
    const parser = core.createStreamingBridgeParser([{ name: 'bash' }], {
      onContent: (text) => contentEmitted += text,
      onToolCall: (call, idx) => calls.push({ call, idx })
    });
    parser.feed('{"v":1,"mode":"tool","message":"Creating folders now.","tool_calls":[{"name":"bash","command":"mkdir -p src tests","description":"Create folders"}]}');
    parser.flush();
    assert.equal(contentEmitted, 'Creating folders now.');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].call.function.name, 'bash');
    assert.deepEqual(JSON.parse(calls[0].call.function.arguments), {
      command: 'mkdir -p src tests',
      description: 'Create folders'
    });
  });
  console.log('  PASS: StreamingObjectParser flattened');
})();
// ---- Test: object bridge assistant tool-call history stays in V3 JSON form ----
(function testObjectBridgeAssistantHistoryEncoding() {
  withBridgeProtocol('object', () => {
    const transformed = core.transformRequestForBridge({
      model: 'test-model',
      messages: [{
        role: 'assistant',
        content: 'Creating project directory structure with Windows commands.',
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: {
            name: 'bash',
            arguments: JSON.stringify({ command: 'mkdir -p incident_simulator/logs', description: 'Create directories' })
          }
        }]
      }],
      tools: [{
        type: 'function',
        function: {
          name: 'bash',
          parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] }
        }
      }]
    });
    const assistantHistory = transformed.rewritten.messages[1].content;
    assert.doesNotMatch(assistantHistory, /ASSISTANT_TOOL_CALLS_JSON/);
    const parsed = JSON.parse(assistantHistory);
    assert.equal(parsed.v, 1);
    assert.equal(parsed.mode, 'tool');
    assert.equal(parsed.message, 'Creating project directory structure with Windows commands.');
    assert.equal(parsed.tool_calls[0].name, 'bash');
  });
  console.log('  PASS: object bridge assistant history encoding');
})();

// ---- Test: object bridge accepts fenced JSON output ----
(function testBuildBridgeResultFromFencedObjectText() {
  withBridgeProtocol('object', () => {
    const result = core.buildBridgeResultFromText('```json\n{"v":1,"mode":"tool","message":"Creating folders now.","tool_calls":[{"name":"bash","arguments":{"command":"mkdir -p src tests"}}]}\n```', '', [{ name: 'bash' }]);
    assert.equal(result.kind, 'tool_calls');
    assert.equal(result.message.content, 'Creating folders now.');
    assert.equal(result.message.tool_calls[0].function.name, 'bash');
  });
  console.log('  PASS: buildBridgeResultFromFencedObjectText');
})();

// ---- Test: object bridge accepts legacy assistant markers with tool payload ----
(function testBuildBridgeResultFromLegacyAssistantMarkers() {
  withBridgeProtocol('object', () => {
    const legacy = '[ASSISTANT_MESSAGE]\nCreating project directory structure with Windows commands.\n\n[ASSISTANT_TOOL_CALLS_JSON]\n{"name":"bash","arguments":{"command":"mkdir -p incident_simulator/logs incident_simulator/tests","description":"Create project directory structure"}}';
    const result = core.buildBridgeResultFromText(legacy, '', [{ name: 'bash' }]);
    assert.equal(result.kind, 'tool_calls');
    assert.equal(result.message.content, 'Creating project directory structure with Windows commands.');
    assert.equal(result.message.tool_calls[0].function.name, 'bash');
    assert.deepEqual(JSON.parse(result.message.tool_calls[0].function.arguments), {
      command: 'mkdir -p incident_simulator/logs incident_simulator/tests',
      description: 'Create project directory structure'
    });
  });
  console.log('  PASS: buildBridgeResultFromLegacyAssistantMarkers');
})();

// ---- Test: object bridge accepts legacy assistant marker typo with tool array ----
(function testBuildBridgeResultFromLegacyAssistantMarkerTypo() {
  withBridgeProtocol('object', () => {
    const legacy = '[ASSASSANT_TOOL_CALLS_JSON]\n[{"name":"bash","arguments":{"command":"mkdir -p incident_simulator/logs","description":"Create project directory structure"}}]';
    const result = core.buildBridgeResultFromText(legacy, '', [{ name: 'bash' }]);
    assert.equal(result.kind, 'tool_calls');
    assert.equal(result.message.content, '');
    assert.equal(result.message.tool_calls[0].function.name, 'bash');
  });
  console.log('  PASS: buildBridgeResultFromLegacyAssistantMarkerTypo');
})();
// ---- Test: object bridge accepts prose wrapped around usable JSON ----
(function testBuildBridgeResultFromProseWrappedObject() {
  withBridgeProtocol('object', () => {
    const wrapped = 'I will do it now.\n\n{"toolCalls":{"function":{"name":"bash","arguments":"{\\"command\\":\\"echo hi\\"}"}},"content":"Running command."}\nThanks';
    const result = core.buildBridgeResultFromText(wrapped, '', [{ name: 'bash' }]);
    assert.equal(result.kind, 'tool_calls');
    assert.equal(result.message.content, 'Running command.');
    assert.equal(result.message.tool_calls[0].function.name, 'bash');
    assert.deepEqual(JSON.parse(result.message.tool_calls[0].function.arguments), { command: 'echo hi' });
  });
  console.log('  PASS: buildBridgeResultFromProseWrappedObject');
})();

// ---- Test: object bridge salvages malformed write batches with raw code strings ----
(function testBuildBridgeResultFromMalformedWriteBatch() {
  withBridgeProtocol('object', () => {
    const malformed = '{"v":1,"mode":"tool","message":"Creating core package modules with generator, parser, detector, and CLI.","tool_calls":[{"name":"write","filePath":"C:\\Cline_test\\incident_simulator\\__init__.py","content":"__version__ = "1.0.0"\n"},{"name":"write","filePath":"C:\\Cline_test\\incident_simulator\\generators\\__init__.py","content":"from .base import LogGenerator\nfrom .api_generator import APILogGenerator\n"}]}'
    const result = core.buildBridgeResultFromText(malformed, '', [{ name: 'write', args: [{ name: 'filePath' }, { name: 'content' }] }]);
    assert.equal(result.kind, 'tool_calls');
    assert.equal(result.message.content, 'Creating core package modules with generator, parser, detector, and CLI.');
    assert.equal(result.message.tool_calls.length, 2);
    assert.equal(result.message.tool_calls[0].function.name, 'write');
    assert.equal(JSON.parse(result.message.tool_calls[0].function.arguments).filePath, 'C:\\Cline_test\\incident_simulator\\__init__.py');
    assert.equal(JSON.parse(result.message.tool_calls[0].function.arguments).content, '__version__ = "1.0.0"\n');
  });
  console.log('  PASS: buildBridgeResultFromMalformedWriteBatch');
})();
// ---- Test: object bridge accepts top-level tool-call arrays ----
(function testBuildBridgeResultFromTopLevelToolArray() {
  withBridgeProtocol('object', () => {
    const result = core.buildBridgeResultFromText('[{"name":"bash","arguments":{"command":"echo hi"}}]', '', [{ name: 'bash' }]);
    assert.equal(result.kind, 'tool_calls');
    assert.equal(result.message.content, '');
    assert.equal(result.message.tool_calls[0].function.name, 'bash');
  });
  console.log('  PASS: buildBridgeResultFromTopLevelToolArray');
})();
(async () => {
  await testPluginIdempotentInstall();
  await testPluginStreamingReturnsImmediately();
  console.log('\nselftest ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});








