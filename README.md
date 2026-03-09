# Nano Proxy

Local OpenAI-compatible proxy for OpenCode and similar coding clients when NanoGPT native tool calling is unreliable.

What it does:

- the client still sends normal OpenAI-style `tools`
- the proxy strips native tool calling before forwarding upstream
- the proxy makes the model use a stricter text-based tool format instead
- the proxy converts that back into normal OpenAI-style `tool_calls` for the client

So the client still sees normal tool calls, but NanoGPT does not have to rely on its native tool-calling behavior.

## Quick Start

1. Put these files in a folder.
2. Open a terminal in that folder.
3. Start the proxy:

```powershell
node server.js
```

4. In OpenCode, create a custom OpenAI-compatible provider that points to:

```text
http://127.0.0.1:8787
```

5. Set your NanoGPT API key on that custom provider.
6. Add or select the model you want on that custom provider.
7. Restart OpenCode if needed.

Important:

- do not use the built-in NanoGPT provider directly with the proxy
- the proxy only forwards the auth header it receives
- your API key must be configured on the custom provider that points to `http://127.0.0.1:8787`

## Optional Overrides

```powershell
$env:UPSTREAM_BASE_URL = "https://nano-gpt.com/api/v1"
$env:PROXY_HOST = "127.0.0.1"
$env:PROXY_PORT = "8787"
node server.js
```

You only need those environment variables if you want to change the defaults. Normally, `node server.js` is enough.

## Optional Debug Logging

Logging is off by default.

You can enable it temporarily with an environment variable:

```powershell
$env:NANO_PROXY_DEBUG = "1"
node server.js
```

Or toggle it persistently inside the proxy folder:

```powershell
.\toggle-debug.ps1
```

Run `.\toggle-debug.ps1` again to turn it back off.

When enabled, logs are written to:

```text
Logs/
```

That folder will contain:

- `activity.log`
- `*-request.json`
- `*-stream.sse`
- `*-response.json`

Health check:

```powershell
Invoke-WebRequest http://127.0.0.1:8787/health
```

## How The Bridge Works

For tool-enabled requests:

1. OpenCode sends `tools` to the proxy.
2. The proxy removes native `tools` before sending upstream.
3. The proxy injects a strict tool protocol into the system prompt.
4. The proxy also appends a short protocol reminder to bridged user turns.
5. The model must answer using one of these marker envelopes:

Tool use:

```text
[[OPENCODE_TOOL]]
{"tool_calls":[{"name":"write","arguments":{"filePath":"a.txt","content":"hello"}}]}
[[/OPENCODE_TOOL]]
```

Multiple tool calls in one turn are also allowed when they are independent:

```text
[[OPENCODE_TOOL]]
{"tool_calls":[
  {"name":"read","arguments":{"filePath":"src/app.js"}},
  {"name":"read","arguments":{"filePath":"src/styles.css"}}
]}
[[/OPENCODE_TOOL]]
```

Final answer:

```text
[[OPENCODE_FINAL]]
done
[[/OPENCODE_FINAL]]
```

6. The proxy parses that envelope and converts it into OpenAI-style `tool_calls` for OpenCode.

## Notes

- Reasoning streams live.
- Tool and final content are buffered until the proxy can classify them safely.
- If the model returns multiple tool calls in one tool envelope, the proxy forwards them as separate tool-call chunks in the same assistant turn.
- This means reliability is prioritized over raw token-by-token passthrough for tool turns.
- Requests without `tools` are forwarded normally.
- For bridged tool turns, the proxy caps upstream `temperature` and `top_p` to reduce protocol drift.
- Debug logging is optional and off by default.
- This proxy currently targets OpenAI-compatible `chat/completions` style tool clients.

## Verification

```powershell
node --check server.js
node selftest.js
```
