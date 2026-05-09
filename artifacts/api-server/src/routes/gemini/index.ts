import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { conversations, messages } from "@workspace/db";
import { ai } from "@workspace/integrations-gemini-ai";
import {
  CreateGeminiConversationBody,
  SendGeminiMessageBody,
  GenerateGeminiImageBody,
  GetGeminiConversationParams,
  DeleteGeminiConversationParams,
  ListGeminiMessagesParams,
  SendGeminiMessageParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/gemini/conversations", async (req, res) => {
  try {
    const rows = await db.select().from(conversations).orderBy(conversations.createdAt);
    res.json(rows.map((c) => ({ id: c.id, title: c.title, createdAt: c.createdAt })));
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/gemini/conversations", async (req, res) => {
  try {
    const body = CreateGeminiConversationBody.parse(req.body);
    const [conv] = await db.insert(conversations).values({ title: body.title }).returning();
    res.status(201).json({ id: conv.id, title: conv.title, createdAt: conv.createdAt });
  } catch (err) {
    req.log.error(err);
    res.status(400).json({ error: "Invalid request" });
  }
});

router.get("/gemini/conversations/:id", async (req, res) => {
  try {
    const { id } = GetGeminiConversationParams.parse({ id: Number(req.params.id) });
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, id));
    if (!conv) return res.status(404).json({ error: "Not found" });
    const msgs = await db.select().from(messages).where(eq(messages.conversationId, id)).orderBy(messages.createdAt);
    res.json({ ...conv, messages: msgs });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.delete("/gemini/conversations/:id", async (req, res) => {
  try {
    const { id } = DeleteGeminiConversationParams.parse({ id: Number(req.params.id) });
    const deleted = await db.delete(conversations).where(eq(conversations.id, id)).returning();
    if (!deleted.length) return res.status(404).json({ error: "Not found" });
    res.status(204).end();
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/gemini/conversations/:id/messages", async (req, res) => {
  try {
    const { id } = ListGeminiMessagesParams.parse({ id: Number(req.params.id) });
    const msgs = await db.select().from(messages).where(eq(messages.conversationId, id)).orderBy(messages.createdAt);
    res.json(msgs);
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/gemini/conversations/:id/messages", async (req, res) => {
  try {
    const { id } = SendGeminiMessageParams.parse({ id: Number(req.params.id) });
    const body = SendGeminiMessageBody.parse(req.body);

    const [conv] = await db.select().from(conversations).where(eq(conversations.id, id));
    if (!conv) return res.status(404).json({ error: "Not found" });

    await db.insert(messages).values({ conversationId: id, role: "user", content: body.content });

    const chatMessages = await db.select().from(messages).where(eq(messages.conversationId, id)).orderBy(messages.createdAt);

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    let fullResponse = "";

    const JARVIS_SYSTEM = `You are Jarvis, a futuristic AI assistant. You are smart, calm, composed, and friendly. You reply in the same language the user speaks — supporting Hindi, English, Nepali, and Bhojpuri naturally. You detect commands like "Open YouTube", "Play music", "Scroll down", etc. and respond conversationally while confirming the action. Examples: "जी सर, YouTube खोल रहा हूँ.", "ठीक है, WhatsApp open कर दिया." You are concise, helpful, and never robotic.`;

    const geminiMessages = chatMessages.map((m) => ({
      role: m.role === "assistant" ? "model" as const : "user" as const,
      parts: [{ text: m.content }],
    }));

    const stream = await ai.models.generateContentStream({
      model: "gemini-2.5-flash",
      contents: [
        { role: "user", parts: [{ text: JARVIS_SYSTEM }] },
        { role: "model", parts: [{ text: "Understood. I am Jarvis, ready to assist." }] },
        ...geminiMessages,
      ],
      config: { maxOutputTokens: 8192 },
    });

    for await (const chunk of stream) {
      const text = chunk.text;
      if (text) {
        fullResponse += text;
        res.write(`data: ${JSON.stringify({ content: text })}\n\n`);
      }
    }

    await db.insert(messages).values({ conversationId: id, role: "assistant", content: fullResponse });

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (err) {
    req.log.error(err);
    res.write(`data: ${JSON.stringify({ error: "Failed to generate response" })}\n\n`);
    res.end();
  }
});

router.post("/gemini/generate-image", async (req, res) => {
  try {
    const body = GenerateGeminiImageBody.parse(req.body);
    const { generateImage } = await import("@workspace/integrations-gemini-ai/image");
    const result = await generateImage(body.prompt);
    res.json(result);
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Image generation failed" });
  }
});

export default router;
