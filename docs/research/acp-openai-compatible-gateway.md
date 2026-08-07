# ACP-to-OpenAI-Compatible Gateway Design

> Status: First phase implemented (gateway contract + CLI-owned command adapter)
>
> Date: 2026-08-07
>
> Goal: Allow alint to use ACP agents through its existing OpenAI-compatible interface without exposing ACP, coding-agent CLIs, or agent sessions to alint.

## Decision Summary

alint remains agent-independent. ACP support lives in a separate gateway. No ACP types or session concepts are added to `packages/core`, model resolution, or the plugin interface.

```text
alint / xsAI
  -> OpenAI-compatible HTTP
  -> ACP gateway
  -> ACP session
  -> coding-agent CLI
```

The gateway exposes the following interface to alint:

- `GET /v1/models`
- `POST /v1/chat/completions`
- Non-streaming and SSE streaming responses
- OpenAI function tools, `tool_choice`, and tool-result messages
- Usage, error, and cancellation propagation

The current implementation covers `/models`, non-streaming text, SSE text, sequential function tools, deferred continuation, `tool_choice`, usage, abort, and TTL. The first transport uses request-scoped MCP Streamable HTTP. A shim for stdio-only agents and streamed or parallel tool calls remain for later phases.

Integration coverage has expanded from a gateway-contract fake to `runAlint`: a real file rule enters the gateway through `ctx.model()`, `generateStructured`, and xsAI. The ACP agent then calls `reportFindings` through MCP, and the test finally asserts the diagnostic and resolved model in the alint `RunResult`.

The gateway implementation owns ACP initialization, sessions, prompts, MCP tools, permissions, timeouts, and process lifecycles. If the gateway is removed, ACP complexity does not move into alint call sites; alint only loses an ordinary OpenAI-compatible endpoint.

The CLI integration lives in `packages/cli`. The config package reads provider models with `driver = "acp"` from the global setup and `.alint/config.toml`. For each lint run, the CLI starts a loopback gateway and materializes the model as a temporary `openai-compatible` provider before handing the configuration to core. No ACP types are added to the provider, model-resolution, or structured-output interfaces in `packages/core`.

## Design Assumptions

### The interface alint currently depends on

`generateStructured` calls `chat/completions` through xsAI. It sends `messages` fully controlled by the plugin and requires the model to call one strict function tool. The tool arguments are the structured result; alint then performs Valibot validation, retry feedback, and usage recording.

The model benchmark requests streamed text from the same endpoint and reads the first text or reasoning delta and the final usage. The provider probe depends on `/models`.

These three paths already form an executable OpenAI-compatible contract. The gateway should satisfy that contract instead of requiring alint to create a separate ACP execution path.

### Semantic differences between ACP and OpenAI chat

ACP is a stateful protocol between a client and a coding agent. The client creates a session and sends a user prompt. The agent reports its work through updates such as message chunks, tool calls, plans, usage, and stop reasons. An OpenAI Chat Completions request carries the complete message history; the caller executes function tools and submits their results in a subsequent request.

The gateway therefore provides wire compatibility. Standard ACP cannot represent the following semantics without loss:

- Native priority among the `system`, `developer`, `assistant`, and `tool` roles
- Sampling parameters such as `temperature`
- Protocol-level enforcement of OpenAI `tool_choice`
- A direct lifecycle correspondence between stateless HTTP requests and long-lived ACP sessions

The gateway handles and records these differences explicitly. They do not enter the alint plugin interface.

## Message Mapping

Each new completion turn retains the original OpenAI messages and passes them to the ACP agent as a deterministic JSON transcript. The gateway does not represent different roles as multiple ACP user turns.

```json
{
  "messages": [
    { "role": "system", "content": "You are a code review judge." },
    { "role": "user", "content": "Review this source." }
  ]
}
```

Outside the transcript, the ACP prompt adds gateway-owned instructions that describe roles, ordering, available tools, and output requirements. Message content remains JSON-encoded so source code or user text cannot conflict with gateway delimiters.

alint continues to control retries. New messages produced by `generateStructured`, including validation feedback, enter the gateway in full as the next OpenAI request.

## General-Purpose Tool Bridge

### Tool registration

The ACP client supplies an MCP server in `session/new.mcpServers`. After connecting, the agent discovers tools through `tools/list` and invokes them through `tools/call`. An OpenAI function tool maps to an MCP tool as follows:

| OpenAI function tool | MCP tool |
| --- | --- |
| `function.name` | `name` |
| `function.description` | `description` |
| `function.parameters` | `inputSchema` |
| Function arguments | `tools/call.arguments` |
| `role: tool` content | `CallToolResult.content` |

The gateway creates a request-scoped tool registry for each completion turn. It prefers an MCP HTTP transport declared by the agent. For an agent that only supports stdio, the gateway starts a stdio shim that forwards MCP messages to the current gateway process. MCP-over-ACP can become another transport after the protocol and target-agent support stabilize; it is not a first-version dependency.

### Why deferred tool calls are necessary

An OpenAI request carries tool schemas but not the `execute` callbacks in the alint process. The MCP server therefore cannot execute these tools directly.

When the gateway receives an MCP `tools/call`, it stores the call and pauses the MCP result. It then converts the same call into an OpenAI `tool_calls` response. After the OpenAI client executes the tool, it sends a `role: tool` message in the next completion request. The gateway locates the pending call by `tool_call_id` and completes the MCP `tools/call` with that message. The ACP agent then continues from where it was waiting.

```text
OpenAI request A
  -> session/new(mcpServers: [request tools])
  -> session/prompt
  -> ACP agent calls MCP tool
  -> gateway stores PendingToolCall
  -> OpenAI response A: tool_calls

OpenAI request B with role: tool
  -> gateway resolves PendingToolCall
  -> ACP agent continues
  -> OpenAI response B: text or next tool_calls
```

`reportFindings` does not need a special path. It is an ordinary forced tool. If the OpenAI client ends generation after receiving this call, the gateway cancels and cleans up the waiting ACP session when the continuation TTL expires.

### Turn state

```ts
interface CompletionTurn {
  expiresAt: number
  pendingToolCalls: Map<string, PendingToolCall>
  requestFingerprint: string
  sessionId: string
}

interface PendingToolCall {
  arguments: unknown
  resolve: (result: CallToolResult) => void
  toolCallId: string
  toolName: string
}
```

These types explain state ownership; they are not confirmed public TypeScript interfaces. The implementation should keep this state inside the gateway.

### `tool_choice`

ACP has no equivalent `tool_choice` field. The gateway implements it through the MCP registry, prompt constraints, and result validation:

| OpenAI value | Gateway behavior |
| --- | --- |
| `none` | Do not expose request tools to the session |
| `auto` | Expose all tools and allow the agent to return text directly |
| `required` | Expose all tools; if the agent calls none, append a constraint and retry |
| Named function | Expose only that function; calling another tool or ending directly fails the constraint |

When `parallel_tool_calls: false`, only one unresolved request tool is allowed. Parallel mode requires returning multiple OpenAI tool calls in one response and waiting for all corresponding tool results. It belongs in the intended compatibility scope, but can be implemented after sequential tool calls pass the contract tests.

### Internal tools and request tools

A coding agent may have built-in shell, filesystem, web, or other tools. ACP `tool_call_update` events report these calls, but they are not the function tools supplied by the OpenAI request.

The gateway produces OpenAI `tool_calls` only from `tools/call` requests received through its request-scoped MCP registry. Other ACP tool updates are available only for logs or diagnostics and must not be exposed as same-named OpenAI function calls.

The default inference profile uses an isolated working directory, an empty initial MCP configuration, and a policy that rejects permissions for side effects. If the target agent cannot disable or restrict built-in tools, the gateway must declare that limitation in the model capability instead of presenting read-only operation as a guarantee.

## Sessions and HTTP Continuation

After returning the first OpenAI tool call, the gateway retains the ACP prompt task. A later request resumes the same turn through its `tool_call_id` and history fingerprint.

The implementation must handle the following states:

- The client never submits a tool result: when the TTL expires, call `session/cancel` and clean up the registry.
- The client or upstream caller cancels the HTTP request: cancel the corresponding ACP work and reject pending MCP calls.
- The client submits a tool result more than once: return the same result or an idempotency error; do not resume the agent twice.
- The gateway restarts: incomplete continuations cannot be recovered, so return an explicit expired or unknown-tool-call error.
- The request history does not match the pending turn: reject the association to prevent delivery of a tool result to another session.
- The agent or MCP transport disconnects: map the failure to an OpenAI error and close the turn.
- The completion ends normally: close the session and request-scoped MCP registry.

If a pending session has expired, the gateway may create a new ACP session from the complete OpenAI history as a fallback. This path loses internal agent context and must be distinguished from a same-session continuation in telemetry.

## Streaming, Usage, and Stop Reasons

| ACP | Chat Completions |
| --- | --- |
| `agent_message_chunk` | `choices[].delta.content` |
| Agent thought | Hidden by default; use an explicit non-standard extension when needed |
| Request-scoped MCP call | Streamed `delta.tool_calls` |
| `end_turn` | `finish_reason: stop` |
| `max_tokens` | `finish_reason: length` |
| Refusal | Provider error or compatible refusal content |
| Cancelled | Close the stream and propagate an abort or cancellation error |
| Usage update / final usage | OpenAI usage; when final usage is unavailable during a deferred tool call, return zero values for xsAI compatibility and emit a compatibility diagnostic |

The gateway does not concatenate plans, permission prompts, or internal tool progress into assistant text. Otherwise, lint results would change with agent UI events.

## Scope of the OpenAI-Compatible Interface

### Phase one

- `/v1/models`
- Non-streaming text from `/v1/chat/completions`
- One function tool or multiple sequential function tools
- `tool_choice` values `none`, `auto`, `required`, and a named function
- Deferred tool-result continuation
- Forced `reportFindings`
- Abort, TTL, and session cleanup
- Usage mapping when usage is available

### Phase two

- SSE text streaming
- Streamed tool-call arguments
- Parallel tool calls
- More complete stop-reason and provider-error mapping
- Agent process pooling and session concurrency limits
- Cross-compatibility tests for MCP HTTP and the stdio shim

### Not currently promised

- The OpenAI Responses interface
- OpenAI built-in tools
- Audio, image generation, or realtime
- Behavioral equivalence for OpenAI sampling parameters
- Native-priority equivalence for system and developer roles
- Arbitrary ACP experimental extensions

The gateway should reject unsupported fields or emit an explicit compatibility diagnostic. It must not silently claim equivalent semantics.

## Impact on alint

External consumers can continue to configure the gateway as an ordinary provider. The alint CLI also ships a command adapter, so a setup file can declare an ACP model directly:

```toml
[[providers]]
id = "local-acp"

[[providers.models]]
id = "codex"
name = "Codex ACP"
driver = "acp"
command = "codex-acp"
args = []
capabilities = [ "tool-call" ]
```

`alint --model local-acp/codex .` starts the gateway for that run. Each completion starts an ACP command process. The gateway closes the corresponding process when the CLI exits, the request is cancelled, or a retained continuation expires. The command inherits the environment that started alint; model `env` values are literal overrides only.

This change affects the setup TOML schema and CLI lifecycle, but it does not change the responsibility of `alint.config.ts`. Committed lint configuration continues to contain files, plugins, rules, and model selectors. Machine-specific commands belong in global setup, while a command standardized by a team can live in `.alint/config.toml`.

## Verification Plan

### Contract fake

First implement a programmable fake ACP agent so end-to-end tests do not depend on a real account or coding-agent CLI. Cover the following cases:

1. The message transcript preserves roles, order, and content.
2. Plain-text completion.
3. The agent calls one request-scoped MCP tool.
4. The agent continues after the OpenAI client returns the tool result.
5. Multiple sequential tool calls.
6. A named forced function and the `required` constraint.
7. TTL cleanup after the client abandons a continuation.
8. Abort cancels both the ACP prompt and pending MCP request.
9. Internal ACP tool updates do not become OpenAI tool calls.
10. Usage and stop-reason mapping.

### alint end-to-end

Use a real HTTP gateway to exercise the contract expressed by the existing core tests:

- `generateStructured` receives `reportFindings` arguments.
- Invalid arguments cause alint to produce retry feedback.
- The benchmark receives a text delta and usage.
- An Apeira agent tool executes in the alint process, and its result resumes the ACP turn through the gateway.

Tests against real Codex or other ACP agents are guarded by environment variables and do not replace fake contract tests.

## Selected Implementation Dependencies

The repository catalog currently includes `@modelcontextprotocol/sdk@^1.30.0` and `h3@2.0.1-rc.25`, but it did not yet depend on the ACP TypeScript SDK when this design was written. On 2026-08-07, the stable entry point of the official ACP SDK corresponds to ACP v1; ACP v2 requires an explicit experimental import. The MCP TypeScript SDK had just released the split-package 2.0.0. The legacy single-package SDK and the new server, Node, and framework packages must be evaluated as separate options rather than migrated as an incidental part of the gateway change.

| Decision | Option | Impact |
| --- | --- | --- |
| ACP client | Official `@agentclientprotocol/sdk` | Reuse stable v1 types, connection handling, and cancellation; keep protocol upgrades local to the adapter |
| ACP client | Handwritten JSON-RPC client | Fewer dependencies, but initialization, bidirectional requests, session updates, and version negotiation become owned implementation |
| MCP server | Reuse `@modelcontextprotocol/sdk@1.30.x` | Consistent with the current workspace and suitable for validating the deferred tool bridge; a later 2.x migration remains a separate change |
| MCP server | Adopt the split `@modelcontextprotocol/server@2` | Use the current official interface across old and new MCP eras; because the release is recent, target ACP agents need validation first |
| HTTP server | Reuse H3 2 | The workspace already has a direct dependency and real Node server tests; localhost Host-header validation remains our responsibility |
| HTTP server | Hono + official MCP Hono adapter | MCP Streamable HTTP, Web Standard streams, and DNS-rebinding protection are already integrated; adds a direct dependency and a second HTTP module |
| HTTP server | `node:http` | No framework dependency; the gateway must own routing, JSON errors, SSE, abort handling, and host validation |

The implementation uses this combination:

1. Stable v1 of the official `@agentclientprotocol/sdk`.
2. The existing `@modelcontextprotocol/sdk@1.30.x`.
3. The existing H3 2.
4. Request-scoped MCP Streamable HTTP first, with a shim for stdio-only agents later.
5. `tinyexec` to start ACP commands, while the official ACP `ndJsonStream` owns the underlying stdin and stdout pipes.

This combination does not migrate the MCP SDK or add another HTTP module. The HTTP transport lets the gateway own MCP-server lifecycle and authentication state. The stdio-only MCP shim, parallel tool calls, and process pooling remain follow-up work.

Regardless of the dependency combination, OpenAI request schemas and gateway configuration schemas continue to use Valibot. ACP and MCP wire types are imported from their owning SDK packages rather than redeclared in the gateway.

## Sources

- [ACP architecture](https://agentclientprotocol.com/get-started/architecture)
- [ACP protocol repository](https://github.com/agentclientprotocol/agent-client-protocol)
- [ACP TypeScript SDK](https://www.npmjs.com/package/@agentclientprotocol/sdk)
- [ACP tool calls](https://agentclientprotocol.com/protocol/tool-calls)
- [MCP-over-ACP RFD](https://agentclientprotocol.com/rfds/mcp-over-acp)
- [MCP specification](https://modelcontextprotocol.io/specification/2025-06-18)
- [MCP TypeScript server guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/server.md)
- [OpenAI Chat Completions schema](https://github.com/openai/openai-openapi/blob/main/openapi.yaml)
- [ACP adapter for Codex CLI](https://github.com/agentclientprotocol/codex-acp)
