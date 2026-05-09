import { Router, type IRouter } from "express";
import { ai } from "@workspace/integrations-gemini-ai";

const router: IRouter = Router();

const JARVIS_SYSTEM = `You are Jarvis, a futuristic AI assistant created to assist via WhatsApp.
You are smart, calm, composed, and always address the user politely.
You reply in the SAME language the user writes in — Hindi, English, Hinglish, Nepali, or Bhojpuri.
If given an image, analyze and describe it accurately and helpfully.
Keep answers concise (2-4 sentences max) unless the user asks for detail.
Your tone: "जी सर, यह रहा जवाब।" / "Sure sir, here you go." / "ठीक है, मैं समझ गया।"
Never say you are ChatGPT or any other AI. You are always Jarvis.`;

// ─── Normalise incoming body from ANY autoresponder format ───────────────────
interface NormalisedMessage {
  message: string;
  phone: string;
  imageBase64?: string;
  mimeType?: string;
  imageUrl?: string;
}

function normalise(body: any): NormalisedMessage | null {
  if (!body || typeof body !== "object") return null;

  // ── Format 1: Our own format ──────────────────────────────────────────────
  // { message, phone, imageBase64, mimeType }
  if (body.message !== undefined || body.imageBase64 !== undefined) {
    return {
      message:     String(body.message ?? ""),
      phone:       String(body.phone ?? body.from ?? body.sender ?? ""),
      imageBase64: body.imageBase64,
      mimeType:    body.mimeType,
      imageUrl:    body.imageUrl ?? body.image_url,
    };
  }

  // ── Format 2: WA Business Cloud API ──────────────────────────────────────
  // { entry[0].changes[0].value.messages[0] }
  const waMessage = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (waMessage) {
    const text  = waMessage.text?.body ?? waMessage.caption ?? "";
    const phone = waMessage.from ?? "";
    const img   = waMessage.image;
    return {
      message:  text || (img ? "Image message received" : ""),
      phone,
      imageUrl: img?.id ? `wa_media:${img.id}` : undefined,
      mimeType: img?.mime_type,
    };
  }

  // ── Format 3: Autoresponder / WA Gateway flat format ─────────────────────
  // { from, body/text/msg, image/photo/media }
  const text =
    body.body ?? body.text ?? body.msg ?? body.message_body ??
    body.content ?? body.userMessage ?? body.query ?? "";
  const phone =
    body.from ?? body.sender ?? body.phone ?? body.number ??
    body.msisdn ?? body.wa_id ?? body.whatsapp ?? "";

  if (text || body.image || body.photo || body.media || body.image_base64) {
    return {
      message:     String(text),
      phone:       String(phone),
      imageBase64: body.image_base64 ?? body.imageData ?? body.base64,
      mimeType:    body.mime_type ?? body.mimeType ?? "image/jpeg",
      imageUrl:    body.image ?? body.photo ?? body.media ?? body.imageUrl,
    };
  }

  // ── Format 4: Ultramsg / WA API services ─────────────────────────────────
  // { data: { from, body, ... } }
  if (body.data) {
    return normalise(body.data);
  }

  // ── Format 5: WATI / Interakt style ──────────────────────────────────────
  // { waId, messageText, type, media: { url, mimeType } }
  if (body.waId || body.messageText) {
    return {
      message:  String(body.messageText ?? body.text ?? ""),
      phone:    String(body.waId ?? body.whatsappNumber ?? ""),
      imageUrl: body.media?.url ?? body.mediaUrl,
      mimeType: body.media?.mimeType ?? body.mediaMimeType,
    };
  }

  // ── Format 6: Plain text string body ─────────────────────────────────────
  if (typeof body === "string" && body.trim()) {
    return { message: body.trim(), phone: "" };
  }

  return null;
}

// ─── Fetch an image URL to base64 ────────────────────────────────────────────
async function urlToBase64(url: string): Promise<{ data: string; mimeType: string } | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") ?? "image/jpeg";
    const buf = await res.arrayBuffer();
    return { data: Buffer.from(buf).toString("base64"), mimeType: ct.split(";")[0] };
  } catch {
    return null;
  }
}

// ─── POST /api/whatsapp/chat ─────────────────────────────────────────────────
router.post("/whatsapp/chat", async (req, res) => {
  try {
    const norm = normalise(req.body);

    if (!norm || (!norm.message && !norm.imageBase64 && !norm.imageUrl)) {
      return res.status(400).json({
        error: "Could not parse request. Send { message } or { body } or WA Cloud API format.",
        reply: "Sorry sir, message format not recognised.",
      });
    }

    // Build Gemini parts
    type Part =
      | { text: string }
      | { inlineData: { mimeType: string; data: string } };

    const userParts: Part[] = [];

    // Attach image if present
    let imgBase64 = norm.imageBase64;
    let imgMime   = norm.mimeType ?? "image/jpeg";

    if (!imgBase64 && norm.imageUrl && !norm.imageUrl.startsWith("wa_media:")) {
      const fetched = await urlToBase64(norm.imageUrl);
      if (fetched) { imgBase64 = fetched.data; imgMime = fetched.mimeType; }
    }

    if (imgBase64) {
      userParts.push({ inlineData: { mimeType: imgMime, data: imgBase64 } });
    }

    userParts.push({
      text: norm.message || (imgBase64 ? "What is in this image? Explain in detail." : "Hello"),
    });

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [
        { role: "user",  parts: [{ text: JARVIS_SYSTEM }] },
        { role: "model", parts: [{ text: "Understood. I am Jarvis, ready to assist you sir." }] },
        { role: "user",  parts: userParts as any },
      ],
      config: { maxOutputTokens: 1024 },
    });

    const reply = response.text?.trim() ?? "सर, कोई जवाब नहीं मिला।";
    req.log.info({ phone: norm.phone, hasImage: !!imgBase64 }, "whatsapp chat handled");

    return res.json({ reply, to: norm.phone });
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({
      error: "Jarvis AI error",
      reply: "सर, system error आ गया। Please try again.",
    });
  }
});

// ─── GET /api/whatsapp/chat — info + format guide ────────────────────────────
router.get("/whatsapp/chat", (_req, res) => {
  res.json({
    status: "online",
    service: "Jarvis WhatsApp AI",
    endpoint: "POST /api/whatsapp/chat",
    supportedFormats: [
      {
        name: "Standard (recommended)",
        example: { message: "Kya haal hai?", phone: "919XXXXXXXXX" },
      },
      {
        name: "With image (base64)",
        example: { message: "Is photo mein kya hai?", imageBase64: "<base64>", mimeType: "image/jpeg", phone: "919XXXXXXXXX" },
      },
      {
        name: "With image URL",
        example: { message: "Describe this", imageUrl: "https://example.com/photo.jpg", phone: "919XXXXXXXXX" },
      },
      {
        name: "Flat autoresponder",
        example: { body: "Hello", from: "919XXXXXXXXX", image: "https://..." },
      },
      {
        name: "WATI / Interakt",
        example: { waId: "919XXXXXXXXX", messageText: "Hi", media: { url: "https://...", mimeType: "image/jpeg" } },
      },
      {
        name: "WhatsApp Cloud API (Meta)",
        note: "Full entry/changes/value/messages[0] structure supported",
      },
    ],
    response: { reply: "string", to: "phone number" },
  });
});

export default router;
