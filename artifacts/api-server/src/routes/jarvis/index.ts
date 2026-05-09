import { Router, type IRouter } from "express";
import { eq, desc } from "drizzle-orm";
import { db } from "@workspace/db";
import { jarvisCommands, jarvisConfig } from "@workspace/db";
import {
  SendJarvisCommandBody,
  UpdateJarvisWebhookConfigBody,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.post("/jarvis/command", async (req, res) => {
  try {
    const body = SendJarvisCommandBody.parse(req.body);

    const [config] = await db.select().from(jarvisConfig).limit(1);
    let webhookSent = false;

    if (config?.webhookUrl && config.enabled) {
      try {
        const webhookRes = await fetch(config.webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: body.action }),
          signal: AbortSignal.timeout(5000),
        });
        webhookSent = webhookRes.ok;
      } catch (webhookErr) {
        req.log.warn({ webhookErr }, "Webhook delivery failed");
      }
    }

    await db.insert(jarvisCommands).values({
      action: body.action,
      transcript: body.transcript ?? null,
      language: body.language ?? null,
      webhookSent,
    });

    res.json({
      success: true,
      action: body.action,
      webhookSent,
      message: webhookSent ? "Command dispatched to MacroDroid" : config?.webhookUrl ? "Webhook failed" : "No webhook configured",
    });
  } catch (err) {
    req.log.error(err);
    res.status(400).json({ error: "Invalid request" });
  }
});

router.get("/jarvis/webhook-config", async (req, res) => {
  try {
    const [config] = await db.select().from(jarvisConfig).limit(1);
    res.json({
      webhookUrl: config?.webhookUrl ?? null,
      enabled: config?.enabled ?? true,
    });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.put("/jarvis/webhook-config", async (req, res) => {
  try {
    const body = UpdateJarvisWebhookConfigBody.parse(req.body);
    const [existing] = await db.select().from(jarvisConfig).limit(1);

    let config;
    if (existing) {
      [config] = await db
        .update(jarvisConfig)
        .set({ webhookUrl: body.webhookUrl, enabled: body.enabled, updatedAt: new Date() })
        .where(eq(jarvisConfig.id, existing.id))
        .returning();
    } else {
      [config] = await db
        .insert(jarvisConfig)
        .values({ webhookUrl: body.webhookUrl, enabled: body.enabled })
        .returning();
    }

    res.json({ webhookUrl: config.webhookUrl, enabled: config.enabled });
  } catch (err) {
    req.log.error(err);
    res.status(400).json({ error: "Invalid request" });
  }
});

router.get("/jarvis/command-history", async (req, res) => {
  try {
    const history = await db
      .select()
      .from(jarvisCommands)
      .orderBy(desc(jarvisCommands.createdAt))
      .limit(50);
    res.json(history);
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
