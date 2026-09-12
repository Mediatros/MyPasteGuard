<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/wordmark-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="assets/wordmark-light.svg">
    <img src="assets/wordmark-light.svg" width="220" height="44" alt="PasteGuard">
  </picture>
</p>

<p align="center">
  <a href="https://github.com/sgasser/pasteguard/actions/workflows/ci.yml"><img src="https://github.com/sgasser/pasteguard/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg" alt="License"></a>
  <a href="https://github.com/sgasser/pasteguard/releases"><img src="https://img.shields.io/github/v/release/sgasser/pasteguard" alt="Release"></a>
</p>

<p align="center">
  <strong>AI gets the context. Not your private data.</strong><br>
  PasteGuard masks PII and secrets before they reach ChatGPT, Claude, Gemini, your API provider, Codex, or Claude Code.
</p>

<p align="center">
  <a href="#browser-chat"><strong>Browser Chat</strong></a> ·
  <a href="#apps--apis"><strong>Apps & APIs</strong></a> ·
  <a href="#coding-agents"><strong>Coding Agents</strong></a> ·
  <a href="https://pasteguard.com/docs"><strong>Documentation</strong></a>
</p>

<p align="center">
  <em>MyPasteGuard is a personal fork of <a href="https://github.com/sgasser/pasteguard">sgasser/pasteguard</a>, adapted to our own use cases. See <a href="#about-this-fork">About This Fork</a>.</em>
</p>

<br/>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/comparison-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="assets/comparison.png">
  <img src="assets/comparison.png" width="100%" alt="PasteGuard masks names, emails, and API keys before they reach AI">
</picture>

<p align="center">
  You keep the originals. Providers see placeholders.<br>
  Run it locally or self-host it in your own infrastructure.
</p>

## What PasteGuard Protects

PasteGuard is a local-first privacy layer for teams that cannot send raw client data, customer records, logs, credentials, or production details directly to model providers.

It works in three places:

### Browser Chat

**ChatGPT, Claude, and Gemini.** Paste customer notes, contracts, support tickets, candidate details, or internal context without sending the raw private values to the chat provider. You see the originals; the AI sees placeholders.

The experimental browser extension is available for ChatGPT, Claude, and Gemini.

**[Install the extension →](https://pasteguard.com/browser-extension)** · **[Chat docs →](https://pasteguard.com/docs/use-cases/chat)**

### Apps & APIs

**Apps, SDKs, and internal AI products.** Point your application to PasteGuard instead of the provider directly.

Change one base URL. PasteGuard masks the request, forwards it to the configured provider, and restores supported placeholders in the response.

**[Apps & APIs docs](https://pasteguard.com/docs/use-cases/api-integration)**

### Coding Agents

**Codex, Claude Code, OpenCode, DeepSeek Harness, Cursor, Windsurf, Copilot, and other coding agents.** Agent prompts often include logs, stack traces, tickets, config files, test fixtures, and codebase context. PasteGuard masks secrets and PII before that context leaves your machine.

Claude Code signed in with a Claude.ai subscription cannot use a proxy; this fork covers that case with a hooks integration, see [`integrations/claude-code/`](integrations/claude-code/README.md).

**[Coding Agents docs](docs/use-cases/coding-tools.mdx)**

## Built For Strict Privacy Rules

PasteGuard is a privacy control point before AI providers. It can support regulated workflows, but it does not replace your legal, security, or compliance program.

Use it when your current options are:

- Do not use cloud AI for sensitive work
- Redact client or production data manually
- Switch to a local model even when a cloud provider would give better results
- Build one-off masking code inside every app

## Quick Start

Run PasteGuard as a local proxy:

```bash
docker run --rm -p 3000:3000 ghcr.io/sgasser/pasteguard:latest
```

Open [localhost:3000](http://localhost:3000) for the dashboard.

Point your app or agent to PasteGuard instead of the provider:

| Target | PasteGuard URL | Original URL |
|----------|----------------|--------------|
| OpenAI | `http://localhost:3000/openai/v1` | `https://api.openai.com/v1` |
| Anthropic | `http://localhost:3000/anthropic` | `https://api.anthropic.com` |
| Codex CLI | `http://localhost:3000/codex` | `https://chatgpt.com/backend-api/codex` |

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:3000/openai/v1")
```

Both `client.chat.completions.create(...)` and `client.responses.create(...)` pass through PasteGuard's privacy pipeline.

For custom config, persistent logs, Docker Compose, or detector settings: **[Read the docs](https://pasteguard.com/docs/installation)**.

## Privacy Modes

<details>
<summary><strong>Mask Mode</strong></summary>

Mask Mode replaces PII and secrets with placeholders before sending the request to the upstream AI provider. Supported responses are restored before they return to the user.

</details>

<details>
<summary><strong>Route Mode</strong></summary>

Route Mode sends requests containing sensitive data to a local LLM such as Ollama, vLLM, or llama.cpp. Requests without sensitive data can still go to the configured cloud provider.

**[Route Mode docs](https://pasteguard.com/docs/concepts/route-mode)**

</details>

## What It Catches

**Personal data**: Names, locations, emails, phone numbers, credit cards, IBANs, IP addresses, and EU VAT numbers. Detection is multilingual.

**Secrets**: API keys for providers such as OpenAI, Anthropic, Stripe, AWS, and GitHub; SSH and PEM private keys; JWT tokens; bearer tokens; passwords; and connection strings.

Both are detected and masked in real time, including streaming responses.

## Dashboard

Every request is logged with masking details. See what was detected, what was masked, and what reached the provider.

<img src="assets/dashboard.png" width="100%" alt="PasteGuard Dashboard">

[localhost:3000](http://localhost:3000)

## How Detection Works

Detection runs as a separate service that PasteGuard calls over HTTP, so you can run it wherever you like. It combines deterministic checks and checksums for structured values with a small AI model ([GLiNER](https://github.com/urchade/GLiNER)) for names and places.

Code, Docker image, and tests are in [`detector/`](detector/).

## Tech Stack

[Bun](https://bun.sh) · [Hono](https://hono.dev) · [GLiNER](https://github.com/urchade/GLiNER) + [python-stdnum](https://arthurdejong.org/python-stdnum/) ([`detector/`](detector/)) · SQLite or Postgres

## About This Fork

MyPasteGuard is a personal fork of [sgasser/pasteguard](https://github.com/sgasser/pasteguard), maintained by [Mediatros](https://github.com/Mediatros). The upstream project remains the reference; this fork tracks it and resynchronises with it regularly.

The changes made here serve our own use cases and are not meant to be general-purpose:

- **Claude Code with a Claude.ai subscription.** The proxy approach requires an API key, so [`integrations/claude-code/`](integrations/claude-code/README.md) adds a hooks-based integration: tool outputs are masked before they enter the context, and placeholders are restored locally in written files and on screen. Authentication is left untouched. Its security model, with each claim labelled as measured, established or not verified, is documented in [`SECURITY.md`](integrations/claude-code/SECURITY.md).
- **The coding agents we use.** Setups for OpenCode and DeepSeek Harness, with DeepSeek reached through the OpenAI-compatible route. Tested status in the table below.
- **Detection tuned for our data.** French phone numbers and a lower `PERSON` confidence floor for dense, mixed-format documents.

### Agents We Tested Ourselves

What we actually ran against this fork, with synthetic data, and what we did not. Setup instructions for every agent below are in the [coding agents docs](docs/use-cases/coding-tools.mdx).

| Agent | Status | What we saw |
|---|---|---|
| Claude Code, Claude.ai subscription (hooks) | Verified end-to-end | Masked before the context, restored locally, zero sensitive value in 119 intercepted requests. Details and limits in [`SECURITY.md`](integrations/claude-code/SECURITY.md) |
| [OpenCode](https://opencode.ai) 1.18.15 (DeepSeek provider) | Verified | One `baseURL` change, masking visible in the dashboard, values restored in responses |
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 0.1.5-rc | Verified, with caveats | Chat and session-title requests both masked. PasteGuard has a single OpenAI-compatible upstream, and the optional `dsh_session_log` extension sends data we do not scan |
| Claude Code with an API key, Codex CLI, Cursor, other OpenAI- or Anthropic-compatible agents | Not tested here | Upstream setups, unchanged by this fork |

Last checked on 2026-09-11, against `claude` 2.1.215.

Engine fixes that benefit everyone are proposed upstream. Everything else stays in this fork. Unless a section says otherwise, the documentation under `docs/` describes upstream behaviour, and the hosted docs at pasteguard.com are upstream's.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines on how to contribute.

## License

[Apache 2.0](LICENSE)
