// Jarvis AI Server — standalone single-file deployment for Railway
// Requires: npm install express cors pino pino-http @google/genai drizzle-orm postgres

import express from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import pino from "pino";
import { GoogleGenAI } from "@google/genai";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
  pgTable, serial, text, integer, boolean, timestamp,
} from "drizzle-orm/pg-core";
import { eq, desc } from "drizzle-orm";

// ─── DB Schema ───────────────────────────────────────────────────────────────
const conversations = pgTable("conversations", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

const messages = pgTable("messages", {
  id: serial("id").primaryKey(),
  conversationId: integer("conversation_id").notNull(),
  role: text("role").notNull(),
  content: text("content").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

const jarvisCommands = pgTable("jarvis_commands", {
  id: serial("id").primaryKey(),
  action: text("action").notNull(),
  transcript: text("transcript"),
  language: text("language"),
  webhookSent: boolean("webhook_sent").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

const jarvisConfig = pgTable("jarvis_config", {
  id: serial("id").primaryKey(),
  webhookUrl: text("webhook_url"),
  enabled: boolean("enabled").notNull().default(true),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// ─── DB Client ───────────────────────────────────────────────────────────────
const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) throw new Error("DATABASE_URL is required");
const sql = postgres(dbUrl, { ssl: "require" });
const db = drizzle(sql);

// ─── Gemini AI ───────────────────────────────────────────────────────────────
const geminiKey    = process.env.AI_INTEGRATIONS_GEMINI_API_KEY;
const geminiBase   = process.env.AI_INTEGRATIONS_GEMINI_BASE_URL;
if (!geminiKey) throw new Error("AI_INTEGRATIONS_GEMINI_API_KEY is required");

const ai = new GoogleGenAI({
  apiKey: geminiKey,
  ...(geminiBase ? { httpOptions: { apiVersion: "", baseUrl: geminiBase } } : {}),
});

const JARVIS_SYSTEM = `You are Jarvis, a futuristic AI assistant. You are smart, calm, composed, and friendly.
You reply in the SAME language the user speaks — Hindi, English, Hinglish, Nepali, or Bhojpuri.
Be concise (2-4 lines). Detect commands like Open YouTube, Play music, etc. and confirm naturally.
Style: "जी सर, YouTube खोल रहा हूँ" / "Sure sir, here you go." / "ठीक है, done कर दिया।"
Never say you are ChatGPT or any other AI. You are always Jarvis.`;

// ─── Logger ───────────────────────────────────────────────────────────────────
const logger = pino({ level: "info" });

// ─── Express App ──────────────────────────────────────────────────────────────
const app = express();
app.use(pinoHttp({ logger }));
app.use(cors());
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));

// ─── Health ───────────────────────────────────────────────────────────────────
app.get("/api/healthz", (_req, res) => res.json({ status: "ok", service: "Jarvis AI" }));

// ─── Gemini Conversations ─────────────────────────────────────────────────────
app.get("/api/gemini/conversations", async (req, res) => {
  try {
    const rows = await db.select().from(conversations).orderBy(conversations.createdAt);
    res.json(rows.map(c => ({ id: c.id, title: c.title, createdAt: c.createdAt })));
  } catch (e) { req.log.error(e); res.status(500).json({ error: "Server error" }); }
});

app.post("/api/gemini/conversations", async (req, res) => {
  try {
    const { title } = req.body;
    if (!title) return res.status(400).json({ error: "title required" });
    const [conv] = await db.insert(conversations).values({ title }).returning();
    res.status(201).json({ id: conv.id, title: conv.title, createdAt: conv.createdAt });
  } catch (e) { req.log.error(e); res.status(400).json({ error: "Invalid request" }); }
});

app.post("/api/gemini/conversations/:id/messages", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { content } = req.body;
    if (!content) return res.status(400).json({ error: "content required" });

    const [conv] = await db.select().from(conversations).where(eq(conversations.id, id));
    if (!conv) return res.status(404).json({ error: "Not found" });

    await db.insert(messages).values({ conversationId: id, role: "user", content });

    const chatMessages = await db.select().from(messages)
      .where(eq(messages.conversationId, id)).orderBy(messages.createdAt);

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const geminiMessages = chatMessages.map(m => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

    let fullResponse = "";
    const stream = await ai.models.generateContentStream({
      model: "gemini-2.5-flash",
      contents: [
        { role: "user", parts: [{ text: JARVIS_SYSTEM }] },
        { role: "model", parts: [{ text: "Understood. I am Jarvis, ready to assist." }] },
        ...geminiMessages,
      ],
      config: { maxOutputTokens: 2048 },
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
  } catch (e) {
    req.log.error(e);
    res.write(`data: ${JSON.stringify({ error: "Failed" })}\n\n`);
    res.end();
  }
});

// ─── Jarvis Commands ──────────────────────────────────────────────────────────
app.post("/api/jarvis/command", async (req, res) => {
  try {
    const { action, transcript, language } = req.body;
    if (!action) return res.status(400).json({ error: "action required" });

    const [config] = await db.select().from(jarvisConfig).limit(1);
    let webhookSent = false;

    if (config?.webhookUrl && config.enabled) {
      try {
        const r = await fetch(config.webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
          signal: AbortSignal.timeout(5000),
        });
        webhookSent = r.ok;
      } catch (e) { req.log.warn({ e }, "Webhook failed"); }
    }

    await db.insert(jarvisCommands).values({
      action, transcript: transcript ?? null, language: language ?? null, webhookSent,
    });

    res.json({ success: true, action, webhookSent,
      message: webhookSent ? "Dispatched to MacroDroid" : "Logged (no webhook)" });
  } catch (e) { req.log.error(e); res.status(400).json({ error: "Invalid request" }); }
});

app.get("/api/jarvis/webhook-config", async (req, res) => {
  try {
    const [config] = await db.select().from(jarvisConfig).limit(1);
    res.json({ webhookUrl: config?.webhookUrl ?? null, enabled: config?.enabled ?? true });
  } catch (e) { req.log.error(e); res.status(500).json({ error: "Server error" }); }
});

app.put("/api/jarvis/webhook-config", async (req, res) => {
  try {
    const { webhookUrl, enabled } = req.body;
    const [existing] = await db.select().from(jarvisConfig).limit(1);
    let config;
    if (existing) {
      [config] = await db.update(jarvisConfig)
        .set({ webhookUrl, enabled, updatedAt: new Date() })
        .where(eq(jarvisConfig.id, existing.id)).returning();
    } else {
      [config] = await db.insert(jarvisConfig).values({ webhookUrl, enabled }).returning();
    }
    res.json({ webhookUrl: config.webhookUrl, enabled: config.enabled });
  } catch (e) { req.log.error(e); res.status(400).json({ error: "Invalid request" }); }
});

app.get("/api/jarvis/command-history", async (req, res) => {
  try {
    const history = await db.select().from(jarvisCommands)
      .orderBy(desc(jarvisCommands.createdAt)).limit(50);
    res.json(history);
  } catch (e) { req.log.error(e); res.status(500).json({ error: "Server error" }); }
});

// ─── WhatsApp Chat (multi-format) ─────────────────────────────────────────────
function normaliseBody(body) {
  if (!body || typeof body !== "object") return null;
  // Standard format
  if (body.message !== undefined || body.imageBase64 !== undefined) {
    return { message: String(body.message ?? ""), phone: String(body.phone ?? body.from ?? ""),
      imageBase64: body.imageBase64, mimeType: body.mimeType, imageUrl: body.imageUrl };
  }
  // WhatsApp Cloud API
  const waMsg = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (waMsg) {
    return { message: waMsg.text?.body ?? waMsg.caption ?? "", phone: waMsg.from ?? "",
      imageUrl: waMsg.image?.id ? null : undefined, mimeType: waMsg.image?.mime_type };
  }
  // Flat / autoresponder / WATI
  const text = body.body ?? body.text ?? body.msg ?? body.message_body ?? body.content ?? body.messageText ?? body.userMessage ?? body.query ?? "";
  const phone = body.from ?? body.sender ?? body.phone ?? body.number ?? body.waId ?? body.whatsapp ?? body.msisdn ?? "";
  if (text || body.image || body.photo || body.media || body.image_base64 || body.imageUrl) {
    return { message: String(text), phone: String(phone),
      imageBase64: body.image_base64 ?? body.imageData ?? body.base64,
      mimeType: body.mime_type ?? body.mimeType ?? "image/jpeg",
      imageUrl: body.image ?? body.photo ?? body.media ?? body.imageUrl ?? body.media?.url };
  }
  if (body.data) return normaliseBody(body.data);
  return null;
}

async function urlToBase64(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const ct = r.headers.get("content-type") ?? "image/jpeg";
    const buf = await r.arrayBuffer();
    return { data: Buffer.from(buf).toString("base64"), mimeType: ct.split(";")[0] };
  } catch { return null; }
}

app.post("/api/whatsapp/chat", async (req, res) => {
  try {
    const norm = normaliseBody(req.body);
    if (!norm || (!norm.message && !norm.imageBase64 && !norm.imageUrl)) {
      return res.status(400).json({ error: "Cannot parse request", reply: "Sorry sir, format not recognised." });
    }

    const userParts = [];
    let imgBase64 = norm.imageBase64;
    let imgMime   = norm.mimeType ?? "image/jpeg";

    if (!imgBase64 && norm.imageUrl) {
      const fetched = await urlToBase64(norm.imageUrl);
      if (fetched) { imgBase64 = fetched.data; imgMime = fetched.mimeType; }
    }

    if (imgBase64) userParts.push({ inlineData: { mimeType: imgMime, data: imgBase64 } });
    userParts.push({ text: norm.message || (imgBase64 ? "Describe this image in detail." : "Hello") });

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [
        { role: "user",  parts: [{ text: JARVIS_SYSTEM }] },
        { role: "model", parts: [{ text: "Understood. I am Jarvis, ready to assist you sir." }] },
        { role: "user",  parts: userParts },
      ],
      config: { maxOutputTokens: 1024 },
    });

    const reply = response.text?.trim() ?? "सर, कोई जवाब नहीं मिला।";
    req.log.info({ phone: norm.phone, hasImage: !!imgBase64 }, "whatsapp handled");
    return res.json({ reply, to: norm.phone });
  } catch (e) {
    req.log.error(e);
    return res.status(500).json({ error: "AI error", reply: "सर, system error। Please try again." });
  }
});

app.get("/api/whatsapp/chat", (_req, res) => {
  res.json({
    status: "online", service: "Jarvis WhatsApp AI",
    endpoint: "POST /api/whatsapp/chat",
    formats: [
      { name: "Standard",     example: { message: "Kya haal hai?", phone: "919XXXXXXXXX" } },
      { name: "Image base64", example: { message: "Kya hai?", imageBase64: "<base64>", mimeType: "image/jpeg" } },
      { name: "Image URL",    example: { message: "Describe", imageUrl: "https://..." } },
      { name: "Flat/gateway", example: { body: "Hello", from: "91..." } },
      { name: "WATI/Interakt",example: { waId: "91...", messageText: "Hi" } },
      { name: "WA Cloud API", note: "Full entry/changes/value/messages[0] supported" },
    ],
    response: { reply: "string", to: "phone" },
  });
});

// ─── Start ─────────────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT ?? 8080);
app.listen(PORT, () => logger.info({ port: PORT }, "Jarvis API Server listening"));
