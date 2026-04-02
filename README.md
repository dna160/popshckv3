# Synthetic Newsroom POC

An autonomous newsroom pipeline that continuously ingests RSS feeds, researches visual context, drafts articles across 5 Japanese/Asian pop-culture content pillars, enforces editorial guardrails, and publishes to WordPress.

## Architecture

```
RSS Feeds → Scout → Researcher → Copywriter → Editor → WordPress / Dashboard
                        ↑              ↑           |
                        └──new images──┘           └──revise (max 3 loops)
```

### The 4-Agent Pipeline

| Agent | Role |
|-------|------|
| **Scout** | Concurrent RSS ingestion, freshness sort, anti-dominance shuffle, parallel LLM triage into 5 pillar buckets. Retries until 10 candidates per pillar are found. Persists empirical feed memory to improve prioritisation each run. |
| **Researcher** | Topic deep-evaluation, source URL crawling for full article content, fact extraction, image sourcing (SERPER + Grok vision). |
| **Copywriter** | Writes 300–400 word articles in Bahasa Indonesia with pillar-appropriate tone, intelligent image placement, mandatory CTA, and Translation Notes-based romanisation. |
| **Editor-in-Chief** | HTTP HEAD image pre-check, full editorial review (headline, word count, writing quality, UU ITE), revision routing, 3-strike UNSALVAGEABLE rule. |

### Article States

| Status | Meaning |
|--------|---------|
| **PROCESSING** | Pipeline is actively working on the article |
| **GREEN** | Passed first try or auto-fix only → auto-published to WordPress |
| **YELLOW** | Passed after 1–2 revision loops → requires human click to publish |
| **RED** | Exhausted 3 revision loops or declared UNSALVAGEABLE → human intervention |
| **PUBLISHED** | Successfully pushed to WordPress REST API |

### WordPress Publishing

- **GREEN** articles are auto-published immediately after passing the Editor
- **YELLOW** and **RED** articles can be force-published from the dashboard by a human reviewer
- Featured image is set via a two-step upload (binary POST + metadata PATCH for `alt_text`)
- Articles are assigned to the correct WordPress category by pillar

---

## Scout Algorithm: Freshness & Parallel Scatter + Empirical Feed Memory

### Phase 1 — Concurrent Aggregation
All `PRIORITY_FEEDS` are fetched simultaneously via `Promise.allSettled`. Each item is tagged with its source feed hostname (`sourceFeed`).

### Phase 2 — Freshness Sort + Age Filter
Items sorted by `pubDate` descending. Items older than 7 days are discarded (14-day window on retries).

### Phase 3 — Anti-Dominance Shuffle
Top 150 freshest items are Fisher-Yates shuffled so a single high-volume feed cannot monopolise the triage queue.

### Phase 4 — Adaptive Batch Triage
Items triaged in parallel batches of 10 via `Promise.all`. After each batch, the remaining pool is re-scored:

```
score(item) = Σ_pillar [ historical_rate(feed, pillar) × (1 − bucket_fill[pillar]) ]
```

- `historical_rate` comes from `backend/data/feed-memory.json` — empirical outcomes, no hardcoded labels
- A feed that has historically produced mostly gaming articles scores near-zero when the gaming bucket is full
- Feeds with no history score 0.5 (neutral)

### Phase 5 — Underquota Retry Loop
If any pillar is below 10 candidates after the initial pass, the Scout re-fetches feeds and repeats triage, keeping existing articles intact. Loop only exits when:
- All 5 pillar buckets reach 10 candidates, **or**
- 3 consecutive re-fetches return zero new items (feeds truly exhausted)

Only URLs that were **actually sent to the LLM** are tracked as seen — items fetched but not yet triaged remain available for retry rounds.

---

## Content Pillars & RSS Feeds

| Pillar | Primary Feeds |
|--------|--------------|
| Japanese Anime | Natalie (via Mastodon proxy) |
| Japanese Gaming | Automaton, 4Gamer, Denfami |
| Japanese Infotainment | Essential Japan, Natalie |
| Japanese Manga | Automaton, Natalie, Denfami |
| Japanese Toys/Collectibles | Dengeki Hobby, Toy People News |

Feed pillar affinity is learned empirically per run — feeds may produce articles across multiple pillars and the system adapts accordingly.

---

## Copywriter Rules

- **Language**: Bahasa Indonesia throughout — headline, body, and all proper nouns
- **Headline**: Latin script only. Japanese Kanji/Kana anywhere in the headline = fail
- **Proper nouns**: Scout Translation Notes provide romanised names (e.g. `鬼滅の刃` → `Kimetsu no Yaiba`) — Copywriter must use these, never raw Kanji
- **Word count**: 300–400 words (Editor accepts 200–400)
- **CTA**: Every article ends with a pillar-appropriate call-to-action in conversational Indonesian
- **Revisions**: Must restructure existing content, not append new paragraphs

---

## Editor Rules

- **Headline FATAL**: Any Kanji/Kana in the headline → automatic FAIL
- **Developer scope**: Japanese, Chinese, and Korean developers/publishers are all in-scope (HoYoverse, NEXON, Netmarble, etc.)
- **Image pre-check**: HTTP HEAD requests with 3s timeout before any LLM call
- **Word count**: 200–400 words
- **Failure reasons**: 4–5 words maximum, blunt and specific
- **3-strike rule**: After 3 failed attempts → UNSALVAGEABLE → article marked RED, Scout finds replacement

---

## Revision Loop State Machine

```
Draft
  │
  ▼
Editor Review
  │
  ├── PASS (attempt 1, no fix)     → GREEN  → auto-publish to WordPress
  ├── PASS (attempt 2–3)           → YELLOW → human review required
  │
  ├── FAIL [MAJOR]      → Copywriter rewrites (restructure only, same word count)
  ├── FAIL [IMAGE]      → Researcher fetches replacement images → Copywriter rewrites
  ├── FAIL [UNSALVAGEABLE] (attempt 3) → RED → Scout replaces topic from candidate pool
  │
  └── Attempt 4+ (loop exhausted)  → RED → human intervention
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Node.js + Express + TypeScript |
| ORM / DB | Prisma + SQLite |
| Frontend | React + Vite + TypeScript + Tailwind CSS |
| LLM | xAI Grok-4-1-fast-reasoning (OpenAI-compatible API) |
| Image search | SERPER Google Search API |
| Web crawling | Native `fetch` + HTML stripping (no external dependency) |
| CMS | WordPress REST API v2 + Application Passwords |
| RSS parsing | `rss-parser` npm package |
| Rate limiting | In-process sliding window (900 RPM) |

---

## Prerequisites

- Node.js 18+
- npm 9+
- xAI API key — [console.x.ai](https://console.x.ai)
- SERPER API key — [serper.dev](https://serper.dev)
- WordPress site with Application Passwords enabled (optional)

---

## Setup

### 1. Install dependencies

```bash
npm run install:all
```

### 2. Configure environment

```bash
cp backend/.env.example backend/.env
```

Edit `backend/.env`:

```env
XAI_API_KEY=your_xai_api_key_here
SERPER_API_KEY=your_serper_api_key_here

# Optional — leave blank to skip auto-publishing
WP_BASE_URL=https://your-wordpress-site.com
WP_USERNAME=your_wp_username
WP_APP_PASSWORD=xxxx xxxx xxxx xxxx xxxx xxxx

DATABASE_URL="file:./dev.db"
PORT=3001
```

**WordPress Application Password**: In WP admin → Users → Edit Profile → Application Passwords → Add New.

### 3. Initialise the database

```bash
npm run db:setup
```

### 4. Start development servers

```bash
npm run dev
```

- Backend API: `http://localhost:3001`
- Frontend dashboard: `http://localhost:5173`

---

## Running the Pipeline

### Via Dashboard (Recommended)
Open `http://localhost:5173` and click **Run Pipeline**.

### Via API
```bash
curl -X POST http://localhost:3001/api/pipeline/trigger
```

### Cron Mode
```bash
npm run pipeline:run
```
Runs immediately, then on schedule. Override:
```env
PIPELINE_CRON_SCHEDULE="0 */2 * * *"
```

---

## API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/articles` | List all articles |
| GET | `/api/articles/:id` | Get single article with full content |
| POST | `/api/articles/:id/publish` | Manually publish to WordPress |
| PATCH | `/api/articles/:id` | Update article content (human edit) |
| DELETE | `/api/articles/:id` | Discard an article |
| GET | `/api/pipeline/status` | Current run status + logs |
| POST | `/api/pipeline/trigger` | Trigger a pipeline run |
| POST | `/api/pipeline/abort` | Abort the running pipeline |
| GET | `/api/pipeline/logs` | Latest pipeline logs |
| GET | `/api/dashboard/stats` | Aggregate statistics |

---

## Project Structure

```
/
├── shared/
│   └── types.ts                   # Shared TypeScript types (Pillar, ScoutItem, etc.)
├── backend/
│   ├── data/
│   │   └── feed-memory.json       # Empirical feed→pillar affinity (auto-generated)
│   ├── prisma/
│   │   └── schema.prisma          # Database schema
│   └── src/
│       ├── agents/
│       │   ├── scout.ts           # Agent 1: RSS triage + feed memory
│       │   ├── researcher.ts      # Agent 2: Crawl + facts + images
│       │   ├── copywriter.ts      # Agent 3: Indonesian article writing
│       │   └── editor.ts          # Agent 4: Editorial review + routing
│       ├── services/
│       │   ├── llm.ts             # Grok client + rate limiter
│       │   ├── rss.ts             # RSS feed parsing + Mastodon proxy support
│       │   ├── crawler.ts         # URL crawl → plain text extraction
│       │   ├── serper.ts          # Image search
│       │   └── wordpress.ts       # WP REST API (posts + media)
│       ├── pipeline.ts            # 4-agent orchestration + revision loop
│       ├── continuous-pipeline.ts # Worker thread wrapper + cron
│       └── server.ts              # Express API server
└── frontend/
    └── src/
        ├── components/
        │   ├── NewsroomFloor.tsx   # Pipeline log + controls
        │   ├── ReviewRoom.tsx      # Article review panel
        │   └── ArticleCard.tsx     # Article card with status colours
        ├── pages/
        │   └── Dashboard.tsx       # Main dashboard
        ├── api.ts                  # API client
        └── types.ts                # Frontend types
```

---

## Troubleshooting

**Backend fails to start** — Check `backend/.env` exists and `DATABASE_URL` is set.

**"XAI_API_KEY environment variable is required"** — Set your xAI API key in `backend/.env`.

**WordPress publish fails** — Verify `WP_BASE_URL`, `WP_USERNAME`, `WP_APP_PASSWORD`. User must have Editor or Administrator role. Application Passwords require WordPress 5.6+. Note: either `WP_BASE_URL` or `WP_URL` is accepted.

**Featured image not showing as thumbnail** — Ensure the article has at least one image with `isFeatured: true`. The system falls back to the first successfully uploaded image if the flagged one fails.

**Scout stays underquota** — The retry loop re-fetches feeds until quota is met or 3 consecutive empty rounds occur. Check pipeline logs for `⚠ Underquota` entries and the per-batch bucket state summary.

**RSS feeds return empty** — Some feeds may be temporarily unavailable. The Scout logs warnings and continues with available feeds. The Mastodon proxy feed (Natalie) has special parsing for title-less items.

**Articles failing with "headline in Japanese"** — The Copywriter must use Translation Notes provided by the Scout. If it ignores them, the Editor will fail the article and route it back for revision.
