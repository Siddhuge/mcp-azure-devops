import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../utils/asyncHandler.js";
import { parseOrThrow } from "../schemas/logs.schema.js";
import { config } from "../config/env.js";
import { runChat } from "../agent/chatAgent.js";
import { AppError } from "../utils/errors.js";

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
    if (!config.llm.enabled) {
      throw new AppError("Chat requires the LLM tier. Set LLM_ENABLED=true and ANTHROPIC_API_KEY.", {
        status: 400,
        code: "LLM_DISABLED",
        expose: true,
      });
    }
    const { messages } = parseOrThrow(chatBodySchema, req.body);
    const result = await runChat(messages);
    res.json(result);
  }),
);

export default chatRouter;
