# NanoProxy

NanoProxy is a bridge layer for NanoGPT when native tool calling is unreliable.

It sits between the client and NanoGPT, replaces fragile native tool-calling with a stricter bridge protocol, and converts the result back into normal OpenAI-style `tool_calls` for the client. That lets tools like OpenCode keep working normally even when NanoGPT would otherwise stop early, leak raw tool text, or return malformed tool output.

## Which mode should I use?

### Use the plugin if you use OpenCode
This is the easiest setup for OpenCode.

- No local proxy server to keep running
- No custom provider setup
- Keep using the normal built-in NanoGPT provider

### Use the standalone server for other tools
Use this if:

- you are not using OpenCode
- your client supports an OpenAI-compatible base URL
- you prefer a separate local proxy process

## OpenCode Plugin Setup

The plugin intercepts NanoGPT API requests inside OpenCode and applies the NanoProxy bridge automatically.

Example config:

```json
{
  "plugin": [
    "file:///path/to/NanoProxy/src/plugin.mjs"
  ]
}
```

Notes:
- Use a real absolute file path.
- On Windows, a valid example looks like:
  - `file:///C:/Users/you/path/to/NanoProxy/src/plugin.mjs`
- After editing the config, restart OpenCode.

### Plugin debug logging

Enable debug logging for one OpenCode run:

```sh
NANOPROXY_DEBUG=1 opencode
```

Optional:
- set `NANOPROXY_LOG=/path/to/file` to change the single event log file location
- set `NANOPROXY_LOG_DIR=/path/to/folder` to change where detailed per-request debug files are written

On Windows, you can also use the same persistent toggle used by the standalone server:

```sh
./toggle-debug.ps1
```

That writes a `.debug-logging` flag file in the repo. When that flag is present, both:
- the OpenCode plugin
- the standalone server

will enable NanoProxy debug logging until you toggle it off again.

When debug mode is enabled, NanoProxy also writes:
- a single event log file
- per-request `*-request.json`
- raw streamed `*-stream.sse`
- parsed `*-response.json`

By default these go into:
- event log: your system temp folder as `nanoproxy-plugin.log`
- detailed logs: your system temp folder under `nanoproxy-plugin-logs`

## Standalone Server Setup

Run the server:

```sh
node server.js
```

Then point your coding tool to:

```text
http://127.0.0.1:8787
```

Keep using your normal NanoGPT API key in that tool.

If your tool supports a custom OpenAI-compatible provider or `baseURL`, use `http://127.0.0.1:8787` there.

Optional overrides:

```sh
UPSTREAM_BASE_URL=https://nano-gpt.com/api/v1
PROXY_HOST=127.0.0.1
PROXY_PORT=8787
BRIDGE_MODELS="zai-org/glm-5,moonshotai/kimi-k2.5:thinking" # Optional: bridge only these model IDs (or substrings of them) directly
node server.js
```

## Optional: BRIDGE_MODELS

`BRIDGE_MODELS` changes which models use the bridge immediately and which models try native-first with bridge fallback.

- Not set: current default behavior. All tool-enabled requests are bridged immediately.
- `BRIDGE_MODELS=""` (empty): all tool-enabled models try native-first, and fall back to the bridge if native output looks bad.
- `BRIDGE_MODELS="zai-org/glm-5,moonshotai/kimi-k2.5:thinking"`: only matching models are bridged immediately. All other tool-enabled models try native-first with the same fallback safety net.

Use model IDs, or substrings of model IDs, not display names. For example:
- `zai-org/glm-5` or `glm-5`
- `moonshotai/kimi-k2.5:thinking` or `kimi-k2.5`

Set it in the environment that starts NanoProxy:
- OpenCode plugin mode: set it before launching OpenCode
- Standalone server mode: set it before running `node server.js`
- Docker: set it in `docker-compose.yml` or with `docker run -e BRIDGE_MODELS=...`

Examples:

```powershell
$env:BRIDGE_MODELS = "glm-5,kimi-k2.5"
opencode
```

```sh
BRIDGE_MODELS="glm-5,kimi-k2.5" node server.js
```

### Server debug logging

Off by default.

Enable for one run:

```sh
NANO_PROXY_DEBUG=1 node server.js
```

Or toggle persistently on Windows:

```sh
./toggle-debug.ps1
```

That same toggle also enables plugin debug logging.

Server logs are written to `Logs/`.

### Health check

```sh
curl http://127.0.0.1:8787/health
```

## Docker

If you want to run the standalone server in Docker instead of running Node directly:

```sh
docker build -t nano-proxy .
docker run --rm -p 8787:8787 nano-proxy
```

Or with Compose:

```sh
docker compose up --build
```

If you want to control bridge-vs-native behavior in Docker, set `BRIDGE_MODELS` in `docker-compose.yml` or with `docker run -e BRIDGE_MODELS=...`.

This still exposes the proxy at:

```text
http://127.0.0.1:8787
```

## What NanoProxy actually does

For tool-enabled requests:

1. It removes the normal native tool-calling structure before sending the request upstream.
2. It tells the model to use a stricter text-based tool format instead.
3. It watches the model output.
4. It converts that output back into normal OpenAI-style `tool_calls`.

So your client still sees normal tool calls, but NanoGPT does not have to rely on its native tool-calling behavior.

## Bridge format

Tool reply:

```text
[[OPENCODE_TOOL]]
[[CALL]]
{"name": "tool_name", "arguments": {"example": true}}
[[/CALL]]
[[/OPENCODE_TOOL]]
```

Multiple independent tool calls in one turn:

```text
[[OPENCODE_TOOL]]
[[CALL]]
{"name": "tool_name", "arguments": {"example": true}}
[[/CALL]]
[[CALL]]
{"name": "tool_name", "arguments": {"another_example": true}}
[[/CALL]]
[[/OPENCODE_TOOL]]
```

Final answer:

```text
[[OPENCODE_FINAL]]
Your answer here.
[[/OPENCODE_FINAL]]
```

## Notes

- Requests without tools are forwarded unchanged.
- Reasoning streams live.
- Tool and final content are buffered until NanoProxy can classify them safely.
- By default, NanoProxy allows up to 5 tool calls in a single assistant turn for models that behave well with batching.
- Some models may still behave better with one tool call per turn.

## Project Structure

```text
NanoProxy/
|-- server.js
|-- src/
|   |-- core.js
|   `-- plugin.mjs
|-- selftest.js
|-- README.md
|-- package.json
|-- Dockerfile
`-- docker-compose.yml
```

## Verification

```sh
node --check server.js
node selftest.js
```

## License

MIT



