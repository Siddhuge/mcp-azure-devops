import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../utils/asyncHandler.js";
import { parseOrThrow } from "../schemas/logs.schema.js";
import { config } from "../config/env.js";
import { runChat, runChatStream } from "../agent/chatAgent.js";
import { AppError } from "../utils/errors.js";
import { audit } from "../audit.js";

function assertLlmEnabled() {
  if (!config.llm.enabled) {
    throw new AppError("Chat requires the LLM tier. Set LLM_ENABLED=true and ANTHROPIC_API_KEY.", {
      status: 400,
      code: "LLM_DISABLED",
      expose: true,
    });
  }
}

const chatBodySchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().min(1).max(8000),
      }),
    )
    .min(1)
    .max(40),
});

export const chatRouter = Router();

chatRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    assertLlmEnabled();
    const { messages } = parseOrThrow(chatBodySchema, req.body);
    const result = await runChat(messages);
    audit(req, {
      action: "chat",
      target: { messages: messages.length, tools: result.toolCalls.map((c) => c.name) },
      costUsd: result.costUsd,
    });
    res.json(result);
  }),
);

// Streaming variant (Server-Sent Events): emits `delta`, `tool`, and `done` frames.
chatRouter.post(
  "/stream",
  asyncHandler(async (req, res) => {
    assertLlmEnabled();
    const { messages } = parseOrThrow(chatBodySchema, req.body);

    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders?.();

    const ac = new AbortController();
    req.on("close", () => ac.abort());

    const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    const toolCalls = [];
    let costUsd = 0;

    await runChatStream(messages, {
      signal: ac.signal,
      onEvent: (e) => {
        if (e.type === "tool") toolCalls.push({ name: e.name, input: e.input });
        if (e.type === "done") costUsd = e.costUsd || 0;
        send(e.type, e);
      },
    });

    audit(req, {
      action: "chat",
      target: { messages: messages.length, tools: toolCalls.map((c) => c.name), stream: true },
      costUsd,
    });
    res.end();
  }),
);

export default chatRouter;
