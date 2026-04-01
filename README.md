# Synthetic Newsroom POC

An autonomous newsroom pipeline that continuously ingests RSS feeds, researches visual context, drafts articles across 5 Japanese pop-culture content pillars, enforces editorial guardrails, and publishes to WordPress.

## Architecture

```
RSS Feeds → Scout → Researcher → Copywriter → Editor → WordPress / Dashboard
                ↑         |            ↑           |
                └─reject──┘            └──revise───┘ (max 3 loops)
```

### The 4-Agent Pipeline

| Agent | Role |
|-------|------|
| Scout | RSS triage — finds exactly 2 articles per pillar (10 total) |
| Researcher | Topic evaluation, image sourcing (SERPER + Grok vision), fact extraction |
| Copywriter | Writes 300–400 word articles with intelligent image placement |
| Editor-in-Chief | Full editorial review, auto-fix minor issues, revision loop |

### Article States

- **GREEN** — Passed first try or with auto-fix only → auto-published to WordPress
- **YELLOW** — Passed after 1–3 revision loops → requires human click to publish
- **RED** — Exhausted 3 revision loops → requires human fix/discard in dashboard
- **PUBLISHED** — Successfully pushed to WordPress REST API
- **FAILED** — 3-strike rule triggered, unrecoverable

## Tech Stack

- **Backend**: Node.js + Express + TypeScript + Prisma + SQLite
- **Frontend**: React + Vite + TypeScript + Tailwind CSS
- **LLM**: xAI Grok-4-1-fast-reasoning via OpenAI-compatible API
- **Image Search**: SERPER Google Search API
- **CMS**: WordPress REST API + Application Passwords
- **RSS Parsing**: `rss-parser` npm package

## Prerequisites

- Node.js 18+
- npm 9+
- xAI API key (https://console.x.ai)
- SERPER API key (https://serper.dev)
- WordPress site with Application Passwords enabled (optional — pipeline works without it)

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

**WordPress Application Password**: In your WordPress admin, go to Users → Edit Profile → Application Passwords → Add New. Copy the generated password (spaces included).

### 3. Initialize the database

```bash
npm run db:setup
```

### 4. Start the development servers

```bash
npm run dev
```

This starts:
- Backend API server on `http://localhost:3001`
- Frontend dashboard on `http://localhost:5173`

## Running the Pipeline

### Via Dashboard (Recommended)

Open `http://localhost:5173` and click **Run Pipeline** in the Newsroom Floor panel.

### Via API

```bash
curl -X POST http://localhost:3001/api/pipeline/trigger
```

### Standalone Worker (Cron Mode)

```bash
npm run pipeline:run
```

Runs immediately, then schedules every 2 hours. Override with:

```env
PIPELINE_CRON_SCHEDULE="0 */2 * * *"
```

## API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/articles` | List all articles |
| GET | `/api/articles/:id` | Get single article with full content |
| POST | `/api/articles/:id/publish` | Manually publish to WordPress |
| DELETE | `/api/articles/:id` | Discard an article |
| GET | `/api/pipeline/status` | Current pipeline run status |
| POST | `/api/pipeline/trigger` | Trigger a pipeline run |
| GET | `/api/pipeline/logs` | Latest pipeline logs |
| GET | `/api/dashboard/stats` | Aggregate statistics |

## Project Structure

```
/
├── package.json              # Root scripts + concurrently
├── shared/
│   └── types.ts              # Shared TypeScript types
├── backend/
│   ├── prisma/
│   │   └── schema.prisma     # Database schema
│   ├── src/
│   │   ├── agents/
│   │   │   ├── scout.ts      # Agent 1: RSS triage
│   │   │   ├── researcher.ts # Agent 2: Research + images
│   │   │   ├── copywriter.ts # Agent 3: Article writing
│   │   │   └── editor.ts     # Agent 4: Editorial review
│   │   ├── services/
│   │   │   ├── llm.ts        # Grok LLM client
│   │   │   ├── rss.ts        # RSS feed parsing
│   │   │   ├── serper.ts     # Image search
│   │   │   └── wordpress.ts  # WP REST API
│   │   ├── pipeline.ts       # 4-agent orchestration
│   │   ├── continuous-pipeline.ts  # Cron worker
│   │   └── server.ts         # Express API server
│   ├── .env.example
│   ├── package.json
│   └── tsconfig.json
└── frontend/
    ├── src/
    │   ├── components/
    │   │   ├── NewsroomFloor.tsx  # Left panel: live status
    │   │   ├── ReviewRoom.tsx    # Right panel: article review
    │   │   └── ArticleCard.tsx   # Individual article card
    │   ├── pages/
    │   │   └── Dashboard.tsx     # Main dashboard page
    │   ├── App.tsx
    │   ├── api.ts                # API client
    │   ├── types.ts              # Frontend types
    │   └── main.tsx
    ├── index.html
    ├── package.json
    ├── tailwind.config.js
    └── vite.config.ts
```

## Content Pillars

| Pillar | RSS Feeds |
|--------|-----------|
| Japanese Anime | Anime News Network, Crunchyroll News |
| Japanese Gaming | Siliconera, Japanese Nintendo |
| Japanese Infotainment | Tokyo Reporter, SoraNews24 |
| Japanese Manga | ComicBook Manga, MangaBlog |
| Japanese Toys/Collectibles | ToyArk, CollectionDX |

## Revision Loop State Machine

```
Article Draft
    │
    ▼
Editor Review
    │
    ├── PASS (revision 0, auto-fix only) → GREEN → Auto-publish to WordPress
    ├── PASS (after 1–3 revisions)       → YELLOW → Human review required
    │
    ├── FAIL (MINOR)  → Auto-fix applied by Editor → re-check
    ├── FAIL (MAJOR)  → Push to Copywriter for full rewrite
    ├── FAIL (IMAGE)  → Push to Copywriter → route to Researcher for new images
    │
    └── FAIL (3rd time) → RED/FAILED → Human intervention required
```

## Troubleshooting

**Backend fails to start**: Check that `backend/.env` exists and `DATABASE_URL` is set.

**"XAI_API_KEY environment variable is required"**: Set your xAI API key in `backend/.env`.

**WordPress publish fails**: Verify `WP_BASE_URL`, `WP_USERNAME`, and `WP_APP_PASSWORD` are correct. Ensure the WordPress user has Editor or Administrator role. Application Passwords require WordPress 5.6+.

**RSS feeds return empty**: Some feeds may be temporarily unavailable. The Scout logs warnings and continues with available feeds.

**Images not loading in dashboard**: SERPER images are sourced from third-party sites. Some may require authentication or have CORS restrictions — this affects display only, not the pipeline.
