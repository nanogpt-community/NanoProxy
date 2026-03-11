# NanoProxy

Local OpenAI-compatible proxy and OpenCode plugin for NanoGPT when native tool calling is unreliable.

## What it does

- The client sends normal OpenAI-style `tools`
- NanoProxy strips native tool calling before forwarding upstream
- The model is given a strict text-based tool protocol instead
- NanoProxy converts the model's text responses back into normal OpenAI-style `tool_calls` for the client

So the client still sees standard tool calls, but NanoGPT does not have to rely on its native tool-calling behavior.

## Two Usage Modes

### 1. OpenCode Plugin Mode (recommended)

The plugin patches `globalThis.fetch` inside the OpenCode process, intercepting NanoGPT API calls transparently. No separate server process or config changes needed.

Add NanoProxy to your OpenCode configuration (`~/.config/opencode/opencode.json`):

```json
{
  "plugin": [
    "file:///path/to/NanoProxy/src/plugin.mjs"
  ]
}
```

That's it. The plugin automatically detects requests to `nano-gpt.com`, applies the bridge transformation, and converts responses back to native `tool_calls` before the AI SDK ever sees them.

### 2. Standalone Server Mode

Run as a local HTTP proxy that sits between your client and NanoGPT.

```sh
node server.js
```

The proxy listens on `http://127.0.0.1:8787` by default.

In OpenCode, create a custom OpenAI-compatible provider pointing to `http://127.0.0.1:8787` with your NanoGPT API key. Do not use the built-in NanoGPT provider alongside the proxy.

#### Environment Variables

```sh
UPSTREAM_BASE_URL=https://nano-gpt.com/api/v1
PROXY_HOST=127.0.0.1
PROXY_PORT=8787
node server.js
```

## Docker

If you do not want to run Node directly, you can run the proxy in Docker instead.

Build and run with Docker:

```sh
docker build -t nano-proxy .
docker run --rm -p 8787:8787 nano-proxy
```

Or use Docker Compose:

```sh
docker compose up --build
```

This starts the proxy on:

```text
http://127.0.0.1:8787
```

The OpenCode setup stays the same:

1. Create a custom OpenAI-compatible provider.
2. Point it to `http://127.0.0.1:8787`.
3. Put your NanoGPT API key on that custom provider.

#### Debug Logging (Server Mode)

Off by default. Enable with:

```sh
NANO_PROXY_DEBUG=1 node server.js
```

Or toggle persistently:

```sh
./toggle-debug.ps1
```

Logs are written to `Logs/` and include `activity.log`, per-request `*-request.json`, `*-stream.sse`, and `*-response.json`.

#### Debug Logging (Plugin Mode)

```sh
NANOPROXY_DEBUG=1 opencode
```

Events are appended to `/tmp/nanoproxy-debug.log` as JSON objects separated by `---`.

#### Health Check

```sh
curl http://127.0.0.1:8787/health
```

## How the Bridge Works

For tool-enabled requests:

1. NanoProxy removes native `tools`, `tool_choice`, and `parallel_tool_calls` before sending upstream.
2. A strict tool protocol is injected into the system prompt.
3. A short protocol reminder is appended to each user turn.
4. The model must respond using one of two marker envelopes:

**Tool use:**

```
[[OPENCODE_TOOL]]
[[CALL]]
{"name": "read", "arguments": {"filePath": "src/app.js"}}
[[/CALL]]
[[/OPENCODE_TOOL]]
```

**Multiple independent tool calls in one turn:**

```
[[OPENCODE_TOOL]]
[[CALL]]
{"name": "read", "arguments": {"filePath": "src/app.js"}}
[[/CALL]]
[[CALL]]
{"name": "read", "arguments": {"filePath": "src/styles.css"}}
[[/CALL]]
[[/OPENCODE_TOOL]]
```

**Final answer:**

```
[[OPENCODE_FINAL]]
Your answer here.
[[/OPENCODE_FINAL]]
```

5. NanoProxy parses the envelope and converts it into OpenAI-style `tool_calls`.

## Notes

- Requests without `tools` are forwarded unchanged.
- Temperature and `top_p` are capped for bridged requests to reduce protocol drift.
- Up to 5 parallel tool calls per turn are supported.
- Reasoning streams through live; tool and final content are buffered until fully classifiable.
- Tool history (previous `tool_calls` / `tool` messages) is re-encoded into text protocol before each upstream call.

## Project Structure

```
NanoProxy/
├── server.js        # Standalone HTTP proxy server
├── src/
│   ├── core.js      # Shared bridge transformation logic
│   └── plugin.mjs   # OpenCode plugin (fetch interceptor)
├── selftest.js      # Test suite
└── package.json
```

## Verification

```sh
node --check server.js
node selftest.js
```

## License

MIT
