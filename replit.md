# Jarvis AI Assistant

A futuristic voice-controlled AI assistant named Jarvis. Users speak commands, Jarvis replies intelligently in multiple languages, detects mobile control commands, and dispatches them to MacroDroid on Android via webhook.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 8080)
- `pnpm --filter @workspace/jarvis run dev` — run the Jarvis frontend (port 21662)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string
- Required env: `AI_INTEGRATIONS_GEMINI_BASE_URL`, `AI_INTEGRATIONS_GEMINI_API_KEY` — auto-provisioned by Replit AI Integrations

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Frontend: React + Vite, Tailwind CSS, Framer Motion
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- AI: Gemini 2.5 Flash via Replit AI Integrations (SSE streaming)
- Voice: Web Speech API (SpeechRecognition + SpeechSynthesis)
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `lib/api-spec/openapi.yaml` — API contract (source of truth)
- `lib/db/src/schema/` — Drizzle DB schemas (conversations, messages, jarvis_commands, jarvis_config)
- `lib/integrations-gemini-ai/` — Gemini AI client library
- `artifacts/api-server/src/routes/gemini/` — Gemini chat routes (SSE streaming)
- `artifacts/api-server/src/routes/jarvis/` — Jarvis command + webhook config routes
- `artifacts/jarvis/src/hooks/use-jarvis.ts` — Core voice AI logic
- `artifacts/jarvis/src/components/orb.tsx` — Animated central orb
- `artifacts/jarvis/src/pages/home.tsx` — Main UI page

## Architecture decisions

- SSE streaming for Gemini responses: Orval can't generate typed hooks for SSE, so the frontend uses raw `fetch` + `ReadableStream`
- Gemini role mapping: DB stores `"assistant"` but Gemini API requires `"model"` — mapped in the route handler
- `@google/genai` added as direct dependency of api-server (esbuild externalizes `@google/*` but the package must be resolvable at runtime)
- Jarvis personality injected as a system-level exchange at the start of every Gemini call
- MacroDroid webhook is optional — commands are always logged in DB even if webhook is unconfigured

## Product

- Full-screen cinematic voice AI interface with animated orb
- Speaks and listens continuously via browser Web Speech API
- Understands Hindi, English, Nepali, Bhojpuri
- Detects 13 mobile commands (OPEN_YOUTUBE, PLAY_MUSIC, etc.)
- Dispatches webhook to MacroDroid for Android automation
- Settings panel to configure MacroDroid webhook URL
- Command history panel showing all past commands
- Conversation history persisted to PostgreSQL

## User preferences

- AI model: Gemini 2.5 Flash (via Replit AI Integrations — no API key needed)
- MacroDroid webhook: POST /api/jarvis/command → dispatches { "action": "OPEN_YOUTUBE" }

## Gotchas

- Web Speech API requires browser microphone permission — Chrome/Edge work best
- Speech Recognition (webkitSpeechRecognition) is Chrome-only; other browsers show graceful fallback
- `@google/genai` must be in api-server's direct dependencies because esbuild externalizes it
- Always run codegen after editing `lib/api-spec/openapi.yaml`

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
- MacroDroid webhook URL is stored in the `jarvis_config` table in the database
