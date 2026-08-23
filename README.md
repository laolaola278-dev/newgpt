# GPT++

> **Give ChatGPT Web a local Coding Agent body.**

GPT++ is a Chrome Extension (Manifest V3) that enhances **ChatGPT Web only**
(`chatgpt.com`). You keep chatting in the normal ChatGPT UI — GPT++ lets the
model reach a real local Agent Runtime with filesystem, shell and git tools,
then injects tool results back into the conversation so it can keep working.

Not a web app. Not a SaaS. No cloud backend. No multi-model adapters.

## Status

**Phase 3 complete — Native Messaging.** On top of the working Agent Loop
(Phase 2), tool execution can now cross into a real local process: the
background runtime routes `execution: 'native'` tools through
`chrome.runtime.connectNative()` to **gptpp-native**, a Rust host speaking the
Chrome Native Messaging framing with a versioned handshake. `native_echo`
proves the full extension ⇄ host round trip; filesystem/shell/git tools land
in Phase 4 behind the same capability layer.

## Quick start

```bash
pnpm install
pnpm dev        # dev build + auto-reload extension
pnpm build      # production build → .output/chrome-mv3/
pnpm zip        # store-ready ZIP  → .output/gpt-plus-plus-<ver>-chrome.zip
pnpm compile    # tsc --noEmit
pnpm test       # vitest (unit)
```

### Native host (Rust)

```bash
cd native-host
cargo test            # 16 protocol/host tests
cargo build --release # → target/release/gptpp-native(.exe)
```

Windows registration (fills the manifest with your current extension ID and
registers it under HKCU — no admin rights):

```powershell
.\scripts\install-native-host.ps1 -ExtensionId <32-char-id-from-chrome://extensions>
```

Re-run it whenever Chrome regenerates the unpacked extension ID. The Side
Panel shows the native host state (Connected / Disconnected + reason) and the
host-reported capabilities.

### Load in Chrome

1. Run `pnpm build`.
2. Open `chrome://extensions`, enable **Developer mode**.
3. Click **Load unpacked**, select `.output/chrome-mv3/`.
4. Visit `https://chatgpt.com/` — a `⚡ GPT++` badge confirms injection, and
   clicking the toolbar icon opens the Side Panel showing *Connected*.

## Architecture

```
Chrome Extension (WXT + React + Tailwind)
├── entrypoints/chatgpt.content.ts   Injection + adapter + agent-loop orchestration
├── entrypoints/background.ts        Service worker: side panel, tool_execute runtime, native client
├── entrypoints/sidepanel/           Connection / conversation / agent / native-host status UI
├── entrypoints/options/             Workspace root setting
├── lib/agent/
│   ├── loop/controller.ts           State machine · parser feed · dedup · limits · injection
│   ├── runtime.ts                   Registry lookup → schema → permission → timeout execute
│   ├── tool-call/                   Fenced protocol: streaming-safe incremental parser
│   ├── tools/                       ToolRegistry + demo_echo (local) + native_echo (host)
│   ├── permission.ts                allow / deny / ask policy core
│   ├── state.ts                     Explicit agent state transitions
│   └── format.ts                    [GPT++ TOOL RESULT] wire block
├── lib/native/
│   ├── client.ts                    NativeMessagingClient: state machine, handshake, timeouts, reconnect
│   ├── protocol.ts                  Chrome NM framing (u32 LE length + JSON), FrameDecoder
│   ├── errors.ts                    Structured native error codes
│   └── types.ts                     Port/capabilities/connection-state types
├── native-host/                     Rust: framing · RPC envelope · dispatcher · handshake · echo
├── lib/chatgpt/
│   ├── adapter.ts                   ChatGPTAdapter — the only DOM interface
│   ├── probe.ts                     Multi-fallback landmark selectors
│   ├── messages.ts                  Message parsing / text extraction
│   ├── streaming.ts                 Streaming state machine (stop-btn + quiet window)
│   ├── conversation.ts              Conversation id/title detection
│   ├── emitter.ts                   Typed events: ready/navigation/message-*/stream-*/composer-changed
│   └── types.ts                     ChatGPTMessage model
└── lib/
    ├── protocol.ts                  RPC envelope: {id, method} → {id, ok, result|error}
    ├── messaging.ts                 Typed tab RPC with timeouts
    └── chatgpt-detect.ts            Single source of truth for host matching
```

Planned (implemented only when a phase needs it):

```
Agent Runtime   loop · tool parser/router · permission · task state · result injector
Tools           filesystem · shell · git · browser
Skills / Memory MCP
Native Host     Chrome Native Messaging bridge to fs/shell/git (Rust or Node)
```

## Roadmap

| Phase | Scope | State |
| ----- | ----- | ----- |
| 0 | WXT + TS + React + MV3 scaffold, content script on chatgpt.com, side panel, options, tests | ✅ done |
| 1 | ChatGPT Adapter: DOM probing, message/streaming/conversation detection, composer control, unified events | ✅ done |
| 2 | Agent Loop: fenced tool-call protocol, streaming parser, registry, permissions, result injection | ✅ done |
| 3 | Native Host over Chrome Native Messaging (Rust, handshake, capability layer) | ✅ done |
| 4 | Filesystem + shell tools (workspace-confined) | |
| 5 | Permission system (READ/WRITE/EXECUTE/GIT/BROWSER) | |
| 6 | Git tools | |
| 7 | Skills / Memory (local only) | |
| 8 | MCP client via native host | |
| 9 | Browser agent tools | |
| 10 | E2E, security hardening, release | |

## Security principles

* Web content never gains system permissions automatically.
* The native host trusts nothing by default: it validates method names,
  argument shapes and protocol version on every request, and only the
  extension origin listed in its manifest may connect.
* Native tools pass through the same permission handshake as local tools;
  the host can never bypass the extension's permission layer.
* Filesystem/shell access is confined to the configured workspace root;
  path traversal is blocked; shell exec requires explicit confirmation,
  with timeout, output limits and cancellation.
* Debug logs record metadata (tool, args shape, duration) — never file
  contents, tokens or secrets.
* All data stays on-device (`chrome.storage`); no cloud dependency.
