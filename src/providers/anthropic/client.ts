/**
 * Anthropic client - simple functions for Anthropic Messages API
 */

import { type AnthropicProviderConfig, getConfig } from "../../config";
import { ProviderError } from "../errors";
import type { AnthropicRequest, AnthropicResponse } from "./types";

export const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_ANTHROPIC_URL = "https://api.anthropic.com";

/**
 * Result from Anthropic client
 */
export type AnthropicResult =
  | {
      isStreaming: true;
      response: ReadableStream<Uint8Array>;
      model: string;
    }
  | {
      isStreaming: false;
      response: AnthropicResponse;
      model: string;
    };

// Hop-by-hop headers and headers recomputed by fetch - never forwarded upstream
const EXCLUDED_HEADERS = new Set([
  "host",
  "content-length",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "proxy-authorization",
  "proxy-connection",
  "accept-encoding",
]);

/**
 * Call Anthropic Messages API
 *
 * Transparent header forwarding - all client headers are passed through unchanged
 * (User-Agent, x-stainless-*, anthropic-beta, auth) so the upstream sees the
 * original client identity. Only hop-by-hop headers are dropped.
 * Config api_key is only used as fallback when no client auth headers present.
 */
export async function callAnthropic(
  request: AnthropicRequest,
  config: AnthropicProviderConfig,
  clientHeaders?: Record<string, string>,
): Promise<AnthropicResult> {
  const isStreaming = request.stream ?? false;
  const baseUrl = (config.base_url || DEFAULT_ANTHROPIC_URL).replace(/\/$/, "");

  const headers: Record<string, string> = {};

  if (clientHeaders) {
    for (const [name, value] of Object.entries(clientHeaders)) {
      const lowerName = name.toLowerCase();
      if (!EXCLUDED_HEADERS.has(lowerName)) {
        headers[lowerName] = value;
      }
    }
  }

  // Body is re-serialized, so content-type is always set by the proxy
  headers["content-type"] = "application/json";

  if (!headers["anthropic-version"]) {
    headers["anthropic-version"] = ANTHROPIC_VERSION;
  }

  // Fallback to config api_key only if no client auth
  if (!headers["x-api-key"] && !headers.authorization && config.api_key) {
    headers["x-api-key"] = config.api_key;
  }

  const timeoutMs = getConfig().server.request_timeout * 1000;
  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify(request),
    signal: timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined,
  });

  if (!response.ok) {
    throw new ProviderError(response.status, response.statusText, await response.text());
  }

  if (isStreaming) {
    if (!response.body) {
      throw new Error("No response body for streaming request");
    }
    return { response: response.body, isStreaming: true, model: request.model };
  }

  return {
    response: await response.json(),
    isStreaming: false,
    model: request.model,
  };
}

/**
 * Get Anthropic provider info for /info endpoint
 */
export function getAnthropicInfo(config: AnthropicProviderConfig): {
  baseUrl: string;
} {
  return {
    baseUrl: config.base_url || DEFAULT_ANTHROPIC_URL,
  };
}
