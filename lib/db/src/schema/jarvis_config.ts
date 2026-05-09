import { boolean, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const jarvisConfig = pgTable("jarvis_config", {
  id: serial("id").primaryKey(),
  webhookUrl: text("webhook_url"),
  enabled: boolean("enabled").notNull().default(true),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type JarvisConfig = typeof jarvisConfig.$inferSelect;
