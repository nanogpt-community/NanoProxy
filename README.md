# NanoProxy

NanoProxy is a local OpenAI-compatible bridge for NanoGPT that makes tool-enabled clients work more reliably by rewriting tool-enabled requests into a stricter upstream bridge protocol and translating the model output back into standard OpenAI-style `content`, `reasoning`, and `tool_calls` for the client.

It supports both:
- an OpenCode plugin
- a standalone local server for OpenAI-compatible tools such as Roo Code, Kilo Code, Zed, Cline-style clients, and similar editors or agents

By default NanoProxy uses an object bridge that asks the upstream model to emit one structured JSON turn object inside normal content. NanoProxy incrementally parses that object and converts it back into native client fields. A legacy XML bridge is still available when needed.

It also supports optional native-first fallback for selected models through `BRIDGE_MODELS`.

## What NanoProxy Does

For tool-enabled requests, NanoProxy:
1. rewrites the upstream request into the selected bridge protocol
2. preserves streaming where possible for reasoning, visible content, and tool calls
3. incrementally parses the bridged model output
4. converts it back into normal OpenAI-style response fields
5. retries once for the specific invalid-empty bridged-turn case

Requests without tools pass through normally.

## Bridge Protocols

NanoProxy supports two bridge protocols for tool-enabled requests.

### Object bridge

This is the current default.

NanoProxy asks the model to return one JSON turn object shaped like this:

```json
{
  "v": 1,
  "mode": "tool",
  "message": "I will inspect the relevant files now.",
  "tool_calls": [
    {
      "name": "read",
      "arguments": {
        "path": "src/index.js"
      }
    }
  ]
}
```

Field meaning:
- `v`: protocol version
- `mode`: `tool`, `final`, or `clarify`
- `message`: user-visible assistant text
- `tool_calls`: tool requests when `mode` is `tool`

When the provider exposes reasoning separately, NanoProxy passes that through separately as reasoning content.

### XML bridge

The XML bridge is still supported as a legacy fallback:

```powershell
$env:BRIDGE_PROTOCOL = "xml"
node server.js
```

If you need it, NanoProxy can still rewrite tool-enabled requests into the older XML-style bridge and convert the result back into standard `tool_calls`.

## BRIDGE_PROTOCOL

`BRIDGE_PROTOCOL` selects which bridge protocol NanoProxy uses after it decides to bridge a tool-enabled request.

- not set: use `object`
- `object`: use the object bridge
- `xml`: use the legacy XML bridge

Examples:

```powershell
$env:BRIDGE_PROTOCOL = "object"
opencode
```

```powershell
$env:BRIDGE_PROTOCOL = "xml"
node server.js
```

```sh
BRIDGE_PROTOCOL=object node server.js
```

## Native-First Fallback and BRIDGE_MODELS

`BRIDGE_MODELS` decides which models bridge immediately and which models try native mode first.

- not set: all tool-enabled requests bridge immediately
- set to an empty string: all tool-enabled requests try native-first, then fall back to the selected bridge protocol if needed
- set to a comma-separated list: matching models bridge immediately, other tool-enabled requests use native-first

Examples:

```powershell
$env:BRIDGE_MODELS = ""
node server.js
```

```powershell
$env:BRIDGE_MODELS = "glm-5,kimi-k2.5"
opencode
```

```sh
BRIDGE_MODELS="glm-5,kimi-k2.5" node server.js
```

Matching is substring-based against the model id.

## OpenCode Plugin Setup

Configure OpenCode to load the plugin:

```json
{
  "plugin": [
    "file:///path/to/NanoProxy/src/plugin.mjs"
  ]
}
```

Windows example:

```json
{
  "plugin": [
    "file:///C:/Users/you/path/to/NanoProxy/src/plugin.mjs"
  ]
}
```

Then restart OpenCode.

### Plugin logging

Plugin logging is off by default.

Enable the structured session log for one run:

```powershell
$env:NANOPROXY_DEBUG = "1"
opencode
```

Enable raw request and response artifacts too:

```powershell
$env:NANOPROXY_DEBUG = "1"
$env:NANOPROXY_RAW_LOGS = "1"
opencode
```

Optional override:
- `NANOPROXY_LOG_DIR` for the plugin log directory

Default plugin log locations:
- session logs: system temp under `nanoproxy-plugin-logs`
- raw artifacts: system temp under `nanoproxy-plugin-logs/raw` when raw logging is enabled

The `.debug-logging` file also enables debug logging.

## Standalone Server Setup

Start the server:

```sh
node server.js
```

Default address:

```text
http://127.0.0.1:8787
```

Environment variables:

```sh
UPSTREAM_BASE_URL=https://nano-gpt.com/api/v1
PROXY_HOST=127.0.0.1
PROXY_PORT=8787
BRIDGE_PROTOCOL=object
BRIDGE_MODELS="glm-5,kimi-k2.5"
node server.js
```

### Server logging

Server logging is off by default.

Enable for one run:

```powershell
$env:NANO_PROXY_DEBUG = "1"
node server.js
```

Or toggle persistently on Windows:

```powershell
./toggle-debug.ps1
```

Server logs are written to `Logs/` as one structured session log per server run.

### Health check

```sh
curl http://127.0.0.1:8787/health
```

Example response:

```json
{
  "ok": true,
  "mode": "object-bridge",
  "port": 8787,
  "upstream": "https://nano-gpt.com/api/v1",
  "debugLogs": false
}
```

When debug logs are enabled, the response also includes `logDir`.

## Docker

NanoProxy server mode works in Docker.

Build and run:

```sh
docker build -t nanoproxy .
docker run --rm -p 8787:8787 nanoproxy
```

Or with Compose:

```sh
docker compose up --build
```

Compose uses the same environment model as the server, so you can add values like `BRIDGE_PROTOCOL`, `BRIDGE_MODELS`, or `NANO_PROXY_DEBUG` there when needed.

## Logging Summary

### Plugin mode
- off by default
- enabled by `NANOPROXY_DEBUG=1|true` or `.debug-logging`
- raw artifacts additionally enabled by `NANOPROXY_RAW_LOGS=1|true`
- logs go to the temp folder under `nanoproxy-plugin-logs`
- one structured session log per plugin run

### Server mode
- off by default
- enabled by `NANO_PROXY_DEBUG=1|true` or `.debug-logging`
- logs go to `Logs/`
- one structured session log per server run

## Reliability Rules

Key behavior:
- bridge activates only for tool-enabled requests
- requests without tools pass through unchanged
- object bridge is the default and XML remains available as a fallback protocol
- bridged output is converted back into normal OpenAI-style response fields
- invalid empty bridged turns are treated as protocol failures, not silent successes
- NanoProxy performs one retry for the specific invalid-empty bridged-turn case: no visible content and no tool call
- native-first passthrough is accepted only when the upstream response already looks structurally valid
- idle bridged SSE streams send keepalive comment frames so clients do not time out as quickly

## Repo Structure

```text
NanoProxy/
|-- Dockerfile
|-- docker-compose.yml
|-- package.json
|-- README.md
|-- selftest.js
|-- server.js
|-- src/
|   |-- core.js
|   |-- object_bridge.js
|   `-- plugin.mjs
`-- toggle-debug.ps1
```

## Verification

```sh
node --check src/core.js
node --check src/object_bridge.js
node --check src/plugin.mjs
node --check server.js
node selftest.js
```

Or:

```sh
npm run check
```
