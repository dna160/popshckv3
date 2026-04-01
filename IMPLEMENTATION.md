# Synthetic Newsroom POC — Implementation Guide

A fully autonomous newsroom pipeline that ingests RSS feeds, researches visual context, drafts articles, and enforces editorial guardrails with a revision loop. Built with Node.js + React + Prisma + Grok-4.

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    Frontend Dashboard (React)               │
│  • Newsroom Floor (pipeline status, per-pillar metrics)    │
│  • Review Room (color-coded articles: GREEN/YELLOW/RED)    │
│  • Live logs streaming from pipeline                       │
└─────────────────────────────────────────────────────────────┘
                              ↕ (HTTP REST API)
┌─────────────────────────────────────────────────────────────┐
│                  Backend Server (Express.js)                │
│  • /api/articles (list, get, publish, discard)            │
│  • /api/pipeline/trigger (manual run)                      │
│  • /api/pipeline/abort (kill running pipeline)            │
│  • /api/pipeline/status (polling endpoint)                │
└─────────────────────────────────────────────────────────────┘
                              ↕
┌─────────────────────────────────────────────────────────────┐
│              Pipeline Worker (Node Worker Thread)           │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  Agent 1: Scout (RSS Feeder & Triage)             │   │
│  │  • Scrapes 10 RSS feeds (2 per pillar)            │   │
│  │  • Returns raw topics for Researcher review       │   │
│  └─────────────────────────────────────────────────────┘   │
│                          ↓                                  │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  Agent 2: Researcher (Investigation & Images)      │   │
│  │  • Deep-evaluates topics vs 5 pillars             │   │
│  │  • SERPER Google Image Search                     │   │
│  │  • Grok vision to validate 3 images per article   │   │
│  └─────────────────────────────────────────────────────┘   │
│                          ↓                                  │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  Agent 3: Copywriter (Draft Writer)               │   │
│  │  • Writes 300–400 word articles                   │   │
│  │  • Pillar-specific tone (anime, gaming, etc.)     │   │
│  │  • Intelligent image placement in markdown       │   │
│  └─────────────────────────────────────────────────────┘   │
│                          ↓                                  │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  Agent 4: Editor-in-Chief (Revision Loop)         │   │
│  │  • Full editorial review (writing, tone, facts)    │   │
│  │  • Auto-fix minor grammatical issues             │   │
│  │  • Push back for major rewrites                  │   │
│  │  • Request image replacement on context failure  │   │
│  │  • Max 3 revision loops → FAILED if exhausted     │   │
│  └─────────────────────────────────────────────────────┘   │
│                          ↓                                  │
│  • WordPress REST API (auto-publish GREEN articles)        │
│  • Prisma + SQLite (persistent state)                      │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. Core Technologies

| Component | Tech | Purpose |
|-----------|------|---------|
| **Backend** | Node.js + TypeScript + Express | REST API, pipeline orchestration |
| **Frontend** | React + TypeScript + Vite + Tailwind | Dashboard, real-time status |
| **Database** | Prisma + SQLite | Article state, pipeline runs, logs |
| **LLM Engine** | Grok-4.1-fast-reasoning (xAI) | All agent reasoning (text + vision) |
| **Image Search** | SERPER Google Search API | Find contextual images |
| **CMS** | WordPress REST API | Auto-publish GREEN articles |
| **Concurrency** | Node.js Worker Threads | Pipeline runs in isolated thread |

---

## 3. The 5 Content Pillars

The entire pipeline is strictly organized around these five content verticals:

1. **Japanese Anime** — streaming, new seasons, production news
2. **Japanese Gaming** — Nintendo, PS, arcade, mobile games
3. **Japanese Infotainment** — news, culture, trending topics
4. **Japanese Manga** — serialization, releases, industry news
5. **Japanese Toys/Collectibles** — figures, models, limited editions

Every article is tagged with one pillar. Scout must find exactly **2 articles per pillar (10 total)** in each run.

---

## 4. The 4-Agent Pipeline

### Agent 1: Scout (RSS Feeder & Triage)
**File:** `backend/src/agents/scout.ts`

- Scrapes 10 RSS feeds (2 per pillar)
- Extracts: title, link, raw HTML/summary
- Quotas: strict enforcement (exactly 2/pillar)
- **Feedback Loop:** If Researcher rejects a topic, Scout keeps searching until quota is met

**RSS Feeds:**
```
Anime:
  - https://www.animenewsnetwork.com/all/rss.xml
  - https://feeds.feedburner.com/crunchyroll/animenews

Gaming:
  - https://www.siliconera.com/feed/
  - https://nintendoeverything.com/feed/

Infotainment:
  - https://www.tokyoreporter.com/feed/
  - https://soranews24.com/feed/

Manga:
  - https://www.cbr.com/tag/manga/feed/
  - https://animecorner.me/category/manga/feed/

Toys/Collectibles:
  - https://www.toyark.com/feed/
  - https://www.figures.com/news/feed/
```

---

### Agent 2: Researcher (Investigation & Images)
**File:** `backend/src/agents/researcher.ts`

**Step 1: Topic Evaluation**
- Uses Grok to deep-check relevance to declared pillar
- Rejects off-topic articles → Scout feedback loop
- Accepts → passes to fact extraction

**Step 2: Fact Extraction**
- Grok extracts 5–8 key facts from title/summary
- Passed to Copywriter for accurate writing

**Step 3: Image Sourcing (3 rounds)**
- SERPER Google Image Search (multiple query variants)
- For each image: uses **Grok vision** to validate relevance
- Loop: find 3 approved images, or exhaust 5 search rounds
- **Warning:** If <3 images found, article still proceeds (with fewer images)

---

### Agent 3: Copywriter (Draft Writer)
**File:** `backend/src/agents/copywriter.ts`

- **Input:** topic, facts, 3 images
- **Output:** markdown article (300–400 words)
- **Tone:** tailored per pillar (e.g., gaming = casual, infotainment = news-like)
- **Image Placement:** intelligently embeds 3 images where they provide context
- **Format:** markdown with `[featured]` label on first image for WordPress

**Pillar Tone Guides:**
```typescript
anime: "enthusiastic, fan-focused, celebrate creators"
gaming: "casual, accessible, highlight gameplay/community"
infotainment: "journalistic, factual, straightforward"
manga: "literary, celebrate storytelling, industry focus"
toys: "collector-focused, detailed, appreciate craftsmanship"
```

---

### Agent 4: Editor-in-Chief (Revision Loop)
**File:** `backend/src/agents/editor.ts`

**Review Checklist:**
- ✓ Writing quality (grammar, clarity, flow)
- ✓ Tone match (pillar-specific)
- ✓ Hallucination check (facts align with source)
- ✓ Image context placement (do images make sense where placed?)
- ✓ Word count (300–400 words)

**Outcomes:**

| Issue Type | Action | Max Attempts |
|-----------|--------|--------------|
| **PASS** | Auto-publish (GREEN) or wait for human (YELLOW) | — |
| **MINOR** (typo, formatting) | Editor auto-fixes, approves | — |
| **MAJOR** (tone, hallucination, structure) | Push back to Copywriter for rewrite | 3 |
| **IMAGE** (context, relevance) | Request new images from Researcher | 3 |
| **EXHAUSTED** (3 failures) | Mark RED, human intervention needed | — |

---

## 5. Article State Machine

```
        Scout         Researcher      Copywriter       Editor
         ↓                ↓                ↓              ↓
    [PROCESSING] ──── [PROCESSING] ──── [PROCESSING] ──── [PROCESSING]
         ↓                ↓                ↓              ↓
       REJECT          REJECT           REVIEW        REVISION LOOP
         ↓                ↓                ↓              ↓
      (feedback)     (feedback)    ┌─────┴──────┬───────┴────┐
                                   ↓            ↓            ↓
                                 PASS        FAIL:        FAIL:
                                           MAJOR       IMAGES
                                   (rewrite)    (new images)
                                   ↓            ↓
                    ┌──────────────┴────────────┘
                    ↓
            TRY AGAIN (Max 3)
                    ↓
         ┌──────────┴──────────┐
         ↓                     ↓
      SUCCESS              FAILED (3 strikes)
         ↓                     ↓
      [FINAL STATUS]      [RED]
         ↓
    ┌────┴──────┐
    ↓           ↓
  GREEN      YELLOW
    ↓           ↓
  AUTO-      HUMAN
 PUBLISH     REVIEW

Legend:
  GREEN:  Passed on first try (or auto-fix only) → auto-published to WordPress
  YELLOW: Passed after 1–3 revisions → dashboard review, human publish
  RED:    Failed all 3 revision attempts → dashboard review, human fix/discard
  FAILED: Rejected by Researcher or exhausted quota → skipped this run
```

---

## 6. Database Schema

**Prisma:**
```prisma
model Article {
  id              String   @id @default(cuid())
  title           String
  pillar          String   // anime | gaming | infotainment | manga | toys
  sourceUrl       String
  status          String   // PROCESSING | GREEN | YELLOW | RED | FAILED | PUBLISHED
  revisionCount   Int      @default(0)
  content         String?  // markdown
  contentHtml     String?  // HTML for WordPress
  images          Json?    // [{url, alt, isFeatured}, ...]
  editorNotes     String?  // feedback from Editor
  wpPostId        Int?
  wpPostUrl       String?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
}

model ProcessedUrl {
  id        String   @id @default(cuid())
  url       String   @unique
  createdAt DateTime @default(now())
}

model PipelineRun {
  id              String   @id @default(cuid())
  status          String   // RUNNING | COMPLETED | FAILED | ABORTED
  articlesProcessed Int @default(0)
  startedAt       DateTime @default(now())
  completedAt     DateTime?
  logs            String?  // JSON stringified [{ timestamp, level, message, agent }, ...]
}
```

---

## 7. REST API Endpoints

### Articles

```
GET /api/articles
  Returns: Article[]
  Polls every 5s in dashboard

GET /api/articles/:id
  Returns: Article (full content)

POST /api/articles/:id/publish
  Body: {} (empty)
  Action: Push YELLOW/RED article to WordPress
  Returns: { wpPostId, wpPostUrl }

DELETE /api/articles/:id
  Action: Discard RED article
```

### Pipeline

```
POST /api/pipeline/trigger
  Action: Start a new pipeline run
  Returns: { message: "Pipeline triggered successfully" }
  Error: 409 if already running

POST /api/pipeline/abort
  Action: Kill the running pipeline worker thread instantly
  Returns: { aborted: true }
  Marks run as ABORTED in DB
  Error: 409 if not running

GET /api/pipeline/status
  Returns: {
    isRunning: boolean,
    currentRun: { id, status, articlesProcessed, logs: [...] } | null,
    lastRun: { id, status, articlesProcessed, logs: [...] } | null
  }

GET /api/pipeline/logs
  Legacy endpoint (deprecated, use /status instead)
```

### Dashboard

```
GET /api/dashboard/stats
  Returns: {
    total: number,
    byStatus: { GREEN, YELLOW, RED, FAILED },
    byPillar: { anime, gaming, infotainment, manga, toys }
  }
```

---

## 8. Frontend Features

### Newsroom Floor (Left Panel)
- **Status Pill:** Running / Idle indicator
- **Article Counts:** Per-pillar breakdown in real-time
- **Metrics:** Total processed, passing, failing
- **Live Logs:** Scrollable log viewer (updates every 5s)
- **Manual Trigger:** "Run Pipeline Now" button (disabled while running)
- **Abort Button:** Red "Abort" button (only visible while running, asks confirmation)

### Review Room (Right Panel)
- **Tabs:** All (5) | Pending (0) | Failed (0) | Auto-Pass (1) | Published (1) | Processing (1) | 3-Strike (2)
- **Search:** Filter by title, URL, pillar
- **Sort:** Latest, oldest, by pillar
- **Color-Coded Cards:**
  - 🟢 **GREEN:** Auto-published, ready-only, "View on WordPress" link
  - 🟡 **YELLOW:** Blue "Publish to WP" button, shows revision count
  - 🔴 **RED:** Red "Discard" button, shows editor notes (why it failed)
- **Article Details:** Title, pillar badge, revision count, source URL, thumbnail image

### Dashboard Header
- Logo + title
- Status pill (Running/Idle) with pulse animation
- **Abort button** (red, appears only during pipeline run)
- Refresh indicator + poll interval display (5s)

---

## 9. The Abort Mechanism

**Architecture:** Pipeline runs in a **Node.js Worker Thread**.

**Why Worker Threads?**
- Each Worker is a separate thread with its own event loop
- `worker.terminate()` immediately stops execution — no waiting for `await` to complete
- LLM calls blocking inside the thread are forcibly interrupted
- Parent process remains responsive (can accept new API requests)

**Flow:**

```typescript
// Parent (Express server)
export async function abortPipeline(): Promise<boolean> {
  if (!worker) return false;

  // 1. Flip UI flag immediately
  isRunning = false;

  // 2. Mark DB as ABORTED right away
  await prisma.pipelineRun.update({
    where: { id: currentRunId },
    data: { status: 'ABORTED', completedAt: new Date() }
  });

  // 3. Hard-kill the worker thread
  await worker.terminate();

  // 4. Reset state
  worker = null;
  currentRunId = null;

  return true;
}
```

**UI Response Time:** Instant. On the next poll (max 5s), dashboard shows:
- Status pill: "Idle"
- Abort button: disappears
- Last run: shows status "ABORTED" with full logs of what ran before termination

---

## 10. Setup & Running

### Prerequisites
```bash
Node.js 18+
npm/yarn
SQLite3 (included with Prisma)
```

### Environment Setup

**`backend/.env`**
```
# xAI Grok API
XAI_API_KEY=your_xai_api_key_here
XAI_BASE_URL=https://api.x.ai/v1
XAI_MODEL=grok-4.1-fast-reasoning

# Image Search
SERPER_API_KEY=your_serper_api_key_here

# WordPress (optional for auto-publish)
WP_URL=https://your-wordpress-site.com
WP_USERNAME=your_username
WP_APP_PASSWORD=your_app_password

# Database
DATABASE_URL="file:./dev.db"

# Server
PORT=3003
```

### Install & Run

```bash
# 1. Root setup
npm run setup          # Installs deps + migrates DB

# 2. Development
npm run dev            # Starts backend (3003) + frontend (5173) concurrently

# 3. Production (manual)
cd backend && npm run dev:backend &
cd frontend && npm run dev:frontend &
```

### Directory Structure

```
/
├── backend/
│   ├── src/
│   │   ├── agents/
│   │   │   ├── scout.ts
│   │   │   ├── researcher.ts
│   │   │   ├── copywriter.ts
│   │   │   └── editor.ts
│   │   ├── services/
│   │   │   ├── llm.ts              # Grok client
│   │   │   ├── rss.ts              # Feed fetching
│   │   │   ├── serper.ts           # Image search
│   │   │   └── wordpress.ts        # WP REST API
│   │   ├── pipeline.ts             # 4-agent orchestrator
│   │   ├── pipeline-runner.ts      # Worker thread entry point
│   │   ├── continuous-pipeline.ts  # Cron + Worker management
│   │   └── server.ts               # Express API
│   ├── prisma/
│   │   └── schema.prisma
│   └── .env
├── frontend/
│   ├── src/
│   │   ├── components/
│   │   │   ├── NewsroomFloor.tsx
│   │   │   ├── ReviewRoom.tsx
│   │   │   └── ArticleCard.tsx
│   │   ├── pages/
│   │   │   └── Dashboard.tsx
│   │   ├── api.ts                  # HTTP client
│   │   └── types.ts
│   └── vite.config.ts
├── shared/
│   └── types.ts                    # Shared TS types
├── README.md
└── IMPLEMENTATION.md               # This file
```

---

## 11. Syntax Index & Command Reference

### Running Commands

```bash
# Start full stack
npm run dev

# Start backend only
cd backend && npm run dev

# Start frontend only
cd frontend && npm run dev

# Database
cd backend && npx prisma studio          # GUI DB browser
cd backend && npx prisma db push         # Migrate schema
cd backend && npx prisma generate        # Generate Prisma Client

# Lint/Format
npm run lint
npm run format

# Build for production
npm run build
```

### API Calls

```bash
# Trigger pipeline
curl -X POST http://localhost:3003/api/pipeline/trigger

# Abort pipeline
curl -X POST http://localhost:3003/api/pipeline/abort

# Get status
curl http://localhost:3003/api/pipeline/status

# List articles
curl http://localhost:3003/api/articles

# Publish article to WordPress
curl -X POST http://localhost:3003/api/articles/{id}/publish

# Discard article
curl -X DELETE http://localhost:3003/api/articles/{id}
```

### Environment Variables

| Var | Example | Notes |
|-----|---------|-------|
| `XAI_API_KEY` | `xai-...` | Get from platform.x.ai |
| `SERPER_API_KEY` | `serper-...` | Get from serper.dev |
| `WP_URL` | `https://site.com` | WordPress site root |
| `WP_USERNAME` | `admin` | WordPress user |
| `WP_APP_PASSWORD` | `xxxx xxxx xxxx xxxx` | 16-char app password |
| `DATABASE_URL` | `file:./dev.db` | SQLite path |
| `PORT` | `3003` | Backend port |

### Git Workflow

```bash
# Start new feature
git checkout -b feature/my-feature

# Commit changes
git commit -m "Add feature X"

# Push to remote
git push origin feature/my-feature

# Create PR
gh pr create --title "Add feature X" --body "Description..."
```

---

## 12. Key Implementation Details

### Grok Vision Integration

```typescript
// Text completion
const response = await client.messages.create({
  model: "grok-4.1-fast-reasoning",
  max_tokens: 1000,
  messages: [{ role: "user", content: prompt }]
});

// Vision (image relevance eval)
const visionResponse = await client.messages.create({
  model: "grok-4.1-fast-reasoning",
  messages: [{
    role: "user",
    content: [
      { type: "text", text: "Is this image relevant to X?" },
      { type: "image", source: { type: "url", url: imageUrl } }
    ]
  }]
});
```

### Markdown → HTML Conversion

```typescript
import { marked } from 'marked';

const htmlContent = await marked.parse(markdownContent);
// Upload to WordPress as `content` (HTML field)
```

### WordPress REST API Auth

```typescript
const credentials = Buffer.from(`${username}:${appPassword}`).toString('base64');
const response = await fetch(`${wpBaseUrl}/wp-json/wp/v2/posts`, {
  method: 'POST',
  headers: {
    'Authorization': `Basic ${credentials}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    title: article.title,
    content: htmlContent,
    featured_media: imageId,
    status: 'publish'
  })
});
```

### Processing URL Deduplication

```typescript
// Check if URL was processed before
const existing = await prisma.processedUrl.findUnique({
  where: { url: sourceUrl }
});

if (!existing) {
  // New URL — process it
  await prisma.processedUrl.create({
    data: { url: sourceUrl }
  });
}
```

---

## 13. Troubleshooting

| Issue | Cause | Fix |
|-------|-------|-----|
| Pipeline never starts | `isRunning` flag stuck true | Restart backend |
| SERPER 403 errors | Invalid/missing API key | Check `.env` XAI_API_KEY |
| Images not found | SERPER rate limit or down | Wait 5min, try again |
| WordPress 401 | Bad credentials | Re-check WP_USERNAME, WP_APP_PASSWORD |
| Database locked | Concurrent writes | Restart backend |
| Abort doesn't work | Worker not initialized | Ensure pipeline actually running (check logs) |
| High latency | Grok overloaded | Inherent LLM latency — normal |

---

## 14. Next Steps & Extensions

- [ ] **Scheduling:** Replace cron with proper job queue (BullMQ, etc.)
- [ ] **Multi-tenant:** Support multiple WordPress sites
- [ ] **Analytics:** Track success rates, avg revision count, pillar performance
- [ ] **Webhooks:** Notify external systems on article state changes
- [ ] **Rollback:** Ability to unpublish articles from WordPress
- [ ] **Bulk operations:** Publish/discard multiple articles at once
- [ ] **A/B testing:** Compare article performance across variants
- [ ] **Custom prompts:** Allow users to write/upload custom agent prompts

---

## 15. License & Credits

Built as a POC (Proof of Concept) demonstrating autonomous newsroom automation.

**Technologies:** OpenAI-compatible Grok API, Prisma, React, Node.js
**Data:** RSS feeds from ANN, Crunchyroll, Siliconera, Tokyo Reporter, SoraNews24, CBR, and others
**Styling:** Tailwind CSS

---

**Last Updated:** April 2, 2026
**Version:** 1.0.0
