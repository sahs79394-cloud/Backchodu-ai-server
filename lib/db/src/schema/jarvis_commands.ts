import { boolean, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const jarvisCommands = pgTable("jarvis_commands", {
  id: serial("id").primaryKey(),
  action: text("action").notNull(),
  transcript: text("transcript"),
  language: text("language"),
  webhookSent: boolean("webhook_sent").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const insertJarvisCommandSchema = createInsertSchema(jarvisCommands).omit({
  id: true,
  createdAt: true,
});

export type JarvisCommand = typeof jarvisCommands.$inferSelect;
export type InsertJarvisCommand = z.infer<typeof insertJarvisCommandSchema>;
