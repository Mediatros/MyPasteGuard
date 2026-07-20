// Anthropic SSE differs from OpenAI: event lines identify message/content events,
// and text arrives as content_block_delta data with delta.type === "text_delta".
// Tool inputs arrive as input_json_delta fragments of JSON source text, so
// placeholders restored there must be JSON-escaped.

import type { MaskingConfig } from "../../config";
import type { PlaceholderContext } from "../../masking/context";
import { StreamRestorer } from "../../masking/stream-restorer";
import type { ContentBlockDeltaEvent, TextDelta } from "./types";

interface ParsedSSEData {
  type: string;
  index?: number;
  delta?: { type: string; text?: string; partial_json?: string };
}

/** Escapes a restored value for insertion inside a JSON string literal */
function jsonEscape(original: string): string {
  return JSON.stringify(original).slice(1, -1);
}

export function createAnthropicUnmaskingStream(
  source: ReadableStream<Uint8Array>,
  piiContext: PlaceholderContext | undefined,
  config: MaskingConfig,
  secretsContext?: PlaceholderContext,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let lineBuffer = "";
  const restorer = new StreamRestorer({ piiContext, secretsContext, config });

  // One restorer per content block index: placeholders can split across
  // input_json_delta chunks, and blocks can interleave in theory.
  const inputRestorers = new Map<number, StreamRestorer>();

  function getInputRestorer(index: number): StreamRestorer {
    let inputRestorer = inputRestorers.get(index);
    if (!inputRestorer) {
      inputRestorer = new StreamRestorer({
        piiContext,
        secretsContext,
        config,
        formatValue: jsonEscape,
      });
      inputRestorers.set(index, inputRestorer);
    }
    return inputRestorer;
  }

  return new ReadableStream({
    async start(controller) {
      const reader = source.getReader();

      // SSE "event:" lines are held back until their "data:" line is processed,
      // so flushed deltas can be injected before a content_block_stop event.
      let pendingEventLine: string | null = null;

      function emit(text: string): void {
        controller.enqueue(encoder.encode(text));
      }

      function emitInputJsonDelta(index: number, partialJson: string): void {
        const event = {
          type: "content_block_delta",
          index,
          delta: { type: "input_json_delta", partial_json: partialJson },
        };
        emit(`event: content_block_delta\ndata: ${JSON.stringify(event)}\n\n`);
      }

      function emitDataLine(data: string): void {
        if (pendingEventLine !== null) {
          emit(`${pendingEventLine}\n`);
          pendingEventLine = null;
        }
        emit(`data: ${data}\n`);
      }

      function dropDataLine(): void {
        pendingEventLine = null;
      }

      function processDataLine(data: string): void {
        let parsed: ParsedSSEData;
        try {
          parsed = JSON.parse(data) as ParsedSSEData;
        } catch {
          // Pass through unparseable data
          emitDataLine(data);
          return;
        }

        if (parsed.type === "content_block_delta" && parsed.delta?.type === "text_delta") {
          const event = parsed as ContentBlockDeltaEvent;
          const textDelta = event.delta as TextDelta;
          const processedText = restorer.restoreChunk(textDelta.text);

          // Only emit if we have content (empty means fully buffered)
          if (processedText) {
            const modifiedEvent = {
              ...parsed,
              delta: { ...textDelta, text: processedText },
            };
            emitDataLine(JSON.stringify(modifiedEvent));
          } else {
            dropDataLine();
          }
          return;
        }

        if (
          parsed.type === "content_block_delta" &&
          parsed.delta?.type === "input_json_delta" &&
          typeof parsed.delta.partial_json === "string" &&
          typeof parsed.index === "number"
        ) {
          const processedJson = getInputRestorer(parsed.index).restoreChunk(
            parsed.delta.partial_json,
          );

          if (processedJson) {
            const modifiedEvent = {
              ...parsed,
              delta: { ...parsed.delta, partial_json: processedJson },
            };
            emitDataLine(JSON.stringify(modifiedEvent));
          } else {
            dropDataLine();
          }
          return;
        }

        if (parsed.type === "content_block_stop" && typeof parsed.index === "number") {
          const inputRestorer = inputRestorers.get(parsed.index);
          if (inputRestorer) {
            const flushed = inputRestorer.flush();
            inputRestorers.delete(parsed.index);
            if (flushed) {
              // Inject remaining buffered input before the block closes
              const held = pendingEventLine;
              pendingEventLine = null;
              emitInputJsonDelta(parsed.index, flushed);
              pendingEventLine = held;
            }
          }
          emitDataLine(data);
          return;
        }

        // Pass through other events unchanged
        emitDataLine(data);
      }

      try {
        while (true) {
          const { done, value } = await reader.read();

          if (done) {
            // Flush tool input buffers for blocks that never got a content_block_stop
            for (const [index, inputRestorer] of inputRestorers) {
              const flushed = inputRestorer.flush();
              if (flushed) {
                emitInputJsonDelta(index, flushed);
              }
            }
            inputRestorers.clear();

            const flushed = restorer.flush();

            // Send flushed content as final text delta
            if (flushed) {
              const finalEvent: ContentBlockDeltaEvent = {
                type: "content_block_delta",
                index: 0,
                delta: { type: "text_delta", text: flushed },
              };
              emit(`event: content_block_delta\ndata: ${JSON.stringify(finalEvent)}\n\n`);
            }

            controller.close();
            break;
          }

          lineBuffer += decoder.decode(value, { stream: true });
          const lines = lineBuffer.split("\n");
          lineBuffer = lines.pop() || "";

          for (const line of lines) {
            // Hold event type lines until their data line is processed
            if (line.startsWith("event: ")) {
              pendingEventLine = line;
              continue;
            }

            // Process data lines
            if (line.startsWith("data: ")) {
              processDataLine(line.slice(6));
              continue;
            }

            // Pass through empty lines and other content
            if (line.trim() === "") {
              emit("\n");
            } else {
              emit(`${line}\n`);
            }
          }
        }
      } catch (error) {
        controller.error(error);
      } finally {
        reader.releaseLock();
      }
    },
  });
}
