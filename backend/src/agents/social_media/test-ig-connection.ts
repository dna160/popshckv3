/**
 * Instagram API Connection Test
 *
 * Validates the IG_ACCESS_TOKEN and discovers the INSTAGRAM_BUSINESS_ACCOUNT_ID
 * by walking the Graph API account hierarchy:
 *
 *   1. GET /me                         — validate token, get user name + ID
 *   2. GET /me/accounts                — list connected Facebook Pages
 *   3. GET /{page-id}?fields=instagram_business_account
 *                                      — resolve IG Business Account ID per page
 *   4. GET /{ig-account-id}?fields=... — verify IG account details
 *   5. Patch .env with discovered IDs
 *
 * Usage:
 *   npx tsx src/agents/social_media/test-ig-connection.ts
 */

import * as fs   from 'fs';
import * as path from 'path';
import dotenv    from 'dotenv';

const ENV_PATH = path.resolve(__dirname, '../../../.env');
dotenv.config({ path: ENV_PATH });

const GRAPH = 'https://graph.facebook.com/v19.0';

// ── Helpers ───────────────────────────────────────────────────────────────────

function log(msg: string): void {
  const time = new Date().toISOString().slice(11, 23);
  console.log(`[${time}] ${msg}`);
}

function separator(label: string): void {
  const line = '─'.repeat(60);
  console.log(`\n${line}`);
  console.log(`  ${label}`);
  console.log(`${line}\n`);
}

async function gqlGet(path: string, token: string, fields?: string): Promise<unknown> {
  const url = new URL(`${GRAPH}${path}`);
  url.searchParams.set('access_token', token);
  if (fields) url.searchParams.set('fields', fields);

  const res = await fetch(url.toString());
  const body = await res.json() as unknown;

  if (!res.ok || (body as Record<string, unknown>)['error']) {
    const err = (body as Record<string, unknown>)['error'] as Record<string, unknown> | undefined;
    throw new Error(
      `Graph API error ${res.status}: ${err?.['message'] ?? JSON.stringify(body)}`
    );
  }

  return body;
}

/** Patch a single key=value line in the .env file (in-place). Skips if already correct. */
function patchEnv(key: string, value: string): void {
  let content = fs.readFileSync(ENV_PATH, 'utf-8');
  const regex = new RegExp(`^${key}=.*$`, 'm');
  const existing = regex.exec(content)?.[0];

  if (existing === `${key}=${value}`) {
    log(`  ✓ .env already correct: ${key}=${value}`);
    return;
  }

  if (regex.test(content)) {
    content = content.replace(regex, `${key}=${value}`);
  } else {
    content = content.trimEnd() + `\n${key}=${value}\n`;
  }

  fs.writeFileSync(ENV_PATH, content, 'utf-8');
  log(`  ✓ .env updated: ${key}=${value}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║     Instagram API Connection Test                        ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  const token = process.env['IG_ACCESS_TOKEN'];
  if (!token) {
    console.error('❌  IG_ACCESS_TOKEN not set in .env — aborting.');
    process.exit(1);
  }
  log(`IG_ACCESS_TOKEN loaded (${token.slice(0, 20)}...)`);

  // ── Step 1: Validate token ────────────────────────────────────────────────
  separator('STEP 1 — Detect Token Type & Validate');

  // Instagram Basic Display API tokens start with "IGAAW" and use graph.instagram.com
  // Instagram Graph API / Facebook tokens use graph.facebook.com
  const isBasicDisplayToken = token.startsWith('IGAAW') || token.startsWith('IGQV') || token.startsWith('IGQ');

  if (isBasicDisplayToken) {
    log(`⚠  Token prefix "${token.slice(0, 8)}..." indicates an Instagram Basic Display API token.`);
    log(`   Basic Display tokens work on graph.instagram.com (personal/creator) — NOT for business publishing.`);
    log(`   Trying graph.instagram.com/me to confirm…\n`);

    try {
      const igMe = await fetch(
        `https://graph.instagram.com/me?fields=id,name,username&access_token=${token}`
      ).then(r => r.json()) as { id?: string; name?: string; username?: string; error?: unknown };

      if (igMe.error) {
        log(`  ❌  graph.instagram.com/me error: ${JSON.stringify(igMe.error)}`);
      } else {
        log(`  ✓  Basic Display API confirmed — @${igMe.username} (ID: ${igMe.id})`);
      }
    } catch (err) {
      log(`  ❌  graph.instagram.com/me failed: ${(err as Error).message}`);
    }

    console.error('\n──────────────────────────────────────────────────────────');
    console.error('  TOKEN TYPE MISMATCH — Action Required');
    console.error('──────────────────────────────────────────────────────────');
    console.error('');
    console.error('  The IG_ACCESS_TOKEN is an Instagram Basic Display API token.');
    console.error('  For PUBLISHING posts via the Instagram Graph API you need:');
    console.error('');
    console.error('  1. A Facebook User Access Token with these permissions:');
    console.error('       instagram_basic');
    console.error('       instagram_content_publish');
    console.error('       pages_show_list');
    console.error('       pages_read_engagement');
    console.error('');
    console.error('  2. Obtained via the Graph API Explorer at:');
    console.error('     https://developers.facebook.com/tools/explorer/');
    console.error('     (Select your app → Add permissions above → Generate token)');
    console.error('');
    console.error('  3. Or via your app\'s OAuth flow:');
    console.error('     https://www.facebook.com/v19.0/dialog/oauth?');
    console.error('     client_id=YOUR_APP_ID&redirect_uri=...&scope=instagram_basic,instagram_content_publish,pages_show_list');
    console.error('');
    console.error('  Your App ID : ' + (process.env['INSTAGRAM_APP_ID'] ?? '(not set)'));
    console.error('');
    process.exit(1);
  }

  const me = await gqlGet('/me', token, 'id,name') as { id: string; name: string };
  log(`✓ Token valid — User: "${me.name}" (ID: ${me.id})`);

  // ── Step 2: List Facebook Pages ───────────────────────────────────────────
  separator('STEP 2 — Facebook Pages (/me/accounts)');

  const pagesRes = await gqlGet('/me/accounts', token) as {
    data: Array<{ id: string; name: string; access_token: string }>;
  };
  const pages = pagesRes.data ?? [];

  if (pages.length === 0) {
    log('⚠  No Facebook Pages found for this token.');
    log('   Make sure the token has pages_show_list permission.');
  } else {
    log(`Found ${pages.length} page(s):`);
    for (const p of pages) {
      log(`  • "${p.name}" (Page ID: ${p.id})`);
    }
  }

  // ── Step 3: Resolve IG Business Account per page ──────────────────────────
  separator('STEP 3 — Resolve Instagram Business Account');

  let igAccountId: string | null = null;
  let fbPageId:    string | null = null;

  // Known pages checked first (may not appear in /me/accounts due to role/permission differences)
  const KNOWN_PAGE_IDS = ['1889526441344115']; // Underground → @storytellers.asia
  const allPageIds = [
    ...KNOWN_PAGE_IDS.map(id => ({ id, name: `(known:${id})`, token })),
    ...pages
      .filter(p => !KNOWN_PAGE_IDS.includes(p.id))
      .map(p => ({ id: p.id, name: p.name, token: p.access_token ?? token })),
  ];

  for (const page of allPageIds) {
    log(`Checking page "${page.name}" (${page.id})…`);

    try {
      const pageData = await gqlGet(
        `/${page.id}`,
        page.token,
        'instagram_business_account{id,username}'
      ) as { instagram_business_account?: { id: string; username?: string } };

      if (pageData.instagram_business_account?.id) {
        igAccountId = pageData.instagram_business_account.id;
        fbPageId    = page.id;
        log(`  ✓ IG Business Account ID: ${igAccountId}  (@${pageData.instagram_business_account.username ?? '?'}) linked to page "${page.name}"`);
        break; // prefer first found; put storytellers page first in KNOWN_PAGE_IDS to prioritise it
      } else {
        log(`  – No IG Business Account linked to this page.`);
      }
    } catch (err) {
      log(`  ⚠  Could not query page ${page.id}: ${(err as Error).message}`);
    }
  }

  // Try direct endpoint as last resort
  if (!igAccountId) {
    log('\nNo IG account found via page walk. Trying /me/instagram_business_accounts…');
    try {
      const directRes = await gqlGet(
        '/me/instagram_business_accounts',
        token,
        'id,name,username'
      ) as { data: Array<{ id: string; name: string; username: string }> };

      const accounts = directRes.data ?? [];
      if (accounts.length > 0) {
        igAccountId = accounts[0].id;
        log(`  ✓ IG Business Account ID: ${igAccountId}  (@${accounts[0].username})`);
      } else {
        log('  – /me/instagram_business_accounts returned empty list.');
      }
    } catch (err) {
      log(`  ⚠  /me/instagram_business_accounts failed: ${(err as Error).message}`);
    }
  }

  if (!igAccountId) {
    console.error('\n❌  Could not resolve INSTAGRAM_BUSINESS_ACCOUNT_ID.');
    console.error('   Ensure the Facebook Page is connected to an Instagram Professional account');
    console.error('   and that the token has instagram_basic + pages_show_list permissions.');
    process.exit(1);
  }

  // ── Step 4: Verify IG account details ─────────────────────────────────────
  separator('STEP 4 — Verify Instagram Account Details');

  try {
    const igDetails = await gqlGet(
      `/${igAccountId}`,
      token,
      'id,name,username,followers_count,media_count'
    ) as {
      id:              string;
      name?:           string;
      username?:       string;
      followers_count?: number;
      media_count?:    number;
    };

    log(`  Account ID       : ${igDetails.id}`);
    log(`  Username         : @${igDetails.username ?? '(unknown)'}`);
    log(`  Name             : ${igDetails.name ?? '(unknown)'}`);
    log(`  Followers        : ${igDetails.followers_count?.toLocaleString() ?? '(unknown)'}`);
    log(`  Posts            : ${igDetails.media_count?.toLocaleString() ?? '(unknown)'}`);
  } catch (err) {
    log(`  ⚠  Could not fetch IG account details: ${(err as Error).message}`);
    log('     (account ID is still valid — details query may need extra permissions)');
  }

  // ── Step 5: Patch .env ────────────────────────────────────────────────────
  separator('STEP 5 — Save IDs to .env');

  patchEnv('INSTAGRAM_BUSINESS_ACCOUNT_ID', igAccountId);
  if (fbPageId) patchEnv('FACEBOOK_PAGE_ID', fbPageId);

  // ── Summary ───────────────────────────────────────────────────────────────
  separator('CONNECTION TEST COMPLETE ✅');

  console.log('  Instagram Business Account ID saved to .env');
  console.log(`  INSTAGRAM_BUSINESS_ACCOUNT_ID=${igAccountId}`);
  if (fbPageId) console.log(`  FACEBOOK_PAGE_ID=${fbPageId}`);
  console.log('');
  console.log('  Next steps:');
  console.log('  • Run the full publisher pipeline to test actual posting');
  console.log('  • Ensure the token has instagram_content_publish permission for posting');
  console.log('');
}

main().catch((err) => {
  console.error('\n❌ Connection test failed:', err);
  process.exit(1);
});
