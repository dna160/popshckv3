/**
 * Social Media Coordinator — Sandbox Test
 *
 * Tests the full creative pipeline end-to-end and writes output images
 * to backend/test-output/. No WordPress upload or social platform API
 * calls are made — purely local image rendering.
 *
 * Usage:
 *   npx tsx src/agents/social_media/test-sandbox.ts
 *   npx tsx src/agents/social_media/test-sandbox.ts --pillar gaming
 *   npx tsx src/agents/social_media/test-sandbox.ts --pillar anime --image https://example.com/image.jpg
 *   npx tsx src/agents/social_media/test-sandbox.ts --skip-vision
 *
 * Flags:
 *   --pillar <name>   anime | gaming | infotainment | manga | toys  (default: anime)
 *   --image  <url>    Source image URL to process (default: built-in test URL per pillar)
 *   --skip-vision     Use a centre focal point instead of calling Grok Vision (faster/offline)
 */

import * as fs   from 'fs';
import * as path from 'path';
import dotenv    from 'dotenv';

// Load .env before importing any agent (llmClient reads XAI_API_KEY at import time)
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

import { HookCopywriter }    from './hook_copywriter/index';
import { FrameGenerator }    from './frame_generator/index';
import { AdversarialEditor } from './adversarial_editor/index';
import { processImage }      from './frame_generator/tools/image_processor';

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const getArg = (flag: string): string | undefined => {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : undefined;
};
const hasFlag = (flag: string): boolean => args.includes(flag);

const PILLAR      = getArg('--pillar') ?? 'anime';
const SKIP_VISION = hasFlag('--skip-vision');

// ── Default test images per pillar ───────────────────────────────────────────
// Using reliable, high-resolution public domain / free-to-use images.
// Swap with any URL you like via --image flag.
const DEFAULT_IMAGE_BY_PILLAR: Record<string, string> = {
  anime:        'https://upload.wikimedia.org/wikipedia/commons/thumb/1/1f/Sharingan_triple.svg/800px-Sharingan_triple.svg.png',
  gaming:       'https://hotpink-dogfish-392833.hostingersite.com/wp-content/uploads/2026/04/article-image-1775550019349.jpg',
  infotainment: 'https://picsum.photos/seed/infotainment/1200/800',
  manga:        'https://picsum.photos/seed/manga/1200/800',
  toys:         'https://hotpink-dogfish-392833.hostingersite.com/wp-content/uploads/2026/04/article-image-1775549835176.jpg',
};

// Use pillar-specific default, then picsum as final fallback
const DEFAULT_IMAGE_URL = DEFAULT_IMAGE_BY_PILLAR[PILLAR] ?? `https://picsum.photos/seed/${PILLAR}${Date.now()}/1200/800`;
const IMAGE_URL         = getArg('--image') ?? DEFAULT_IMAGE_URL;

// ── Test articles per pillar ──────────────────────────────────────────────────
const TEST_ARTICLES: Record<string, string> = {
  anime: `# Demon Slayer Season 4: Arc Hashira Training Resmi Dikonfirmasi!

Studio Ufotable telah secara resmi mengumumkan bahwa Demon Slayer: Kimetsu no Yaiba Season 4 akan mengadaptasi arc Hashira Training secara penuh. Pengumuman ini datang bersamaan dengan rilisnya visual key baru yang memperlihatkan Tanjiro sedang berlatih bersama Flame Hashira Rengoku.

Season baru ini dijadwalkan tayang pada musim panas 2025. Menurut laporan, arc ini akan terdiri dari 10 episode dengan kualitas animasi yang diklaim melampaui arc Entertainment District yang telah memenangkan berbagai penghargaan internasional.

Penggemar anime Jepang di seluruh dunia menyambut berita ini dengan antusias. Di Twitter Jepang, hashtag #KimetsuNoYaiba langsung trending dalam hitungan menit setelah pengumuman resmi dilakukan oleh Ufotable melalui akun Twitter resmi mereka.`,

  gaming: `# Panduan Rossi Arknights: Endfield – Attacker Serba Bisa Firepower Gila!

Hypergryph dan GRYPHLINE baru saja buka special scout 'Wolf Pearl' untuk Arknights: Endfield pada 29 Maret lalu. Sorotan utamanya? Operator ★6 baru bernama Rossi, attacker hybrid physical-arts yang bikin tim kamu ngegas maksimal! Dengan DPS tinggi, self-buff, self-heal, sustained damage, plus debuff jahat, Rossi cocok banget buat komposisi physical maupun arts. Dia bisa pair sama hampir semua operator, tapi gimana cara maksimalin potensinya? Yuk, breakdown lengkap ala gamer pro!

Battle Skill Rossi aktif di musuh yang sudah crashed: nambah burn damage plus debuff 'Dyeing Claw Marks' selama 25 detik. Efeknya? 30% ATK sebagai physical DoT per detik, ditambah musuh kena +12% physical/burn damage received. Total extra damage capai ~750% ATK – gila kan? Ini bikin Rossi jadi mimpi buruk buat enemy tanky!

Chain Skill Rossi fokus pada burst damage saat musuh kena crash. Ia nembak area pakai arts damage, terus self-heal 16% Max HP. Pas musuh kena DoT dari Battle Skill, Chain Skill-nya makin sakti. Kombinasi keduanya bikin Rossi jadi sustained DPS yang susah dibunuh.

Untuk build optimal, prioritaskan ATK dan CRIT DMG. Rossi cocok dipasangkan dengan operator yang bisa crash musuh (misalnya Pith atau Defender tanky). Tim ideal: Rossi sebagai DPS utama, satu crasher, satu healer/support arts. Dengan setup ini, Rossi bisa solo most stages di Arknights: Endfield.`,

  infotainment: `# Yoasobi Umumkan Konser World Tour 2025, Jakarta Masuk Daftar!

Duo musik Jepang fenomenal YOASOBI telah mengumumkan tur konser dunia pertama mereka bertajuk "Into The Night World Tour 2025". Yang membuat penggemar Indonesia histeris, Jakarta masuk sebagai salah satu kota yang akan dikunjungi pada tanggal 12 Juli 2025.

Ikura dan Ayase akan membawa setlist penuh hits mereka termasuk "Idol", "Yoru ni Kakeru", dan lagu-lagu dari album terbaru mereka. Ini akan menjadi penampilan pertama YOASOBI di Indonesia setelah bertahun-tahun penggemarnya menantikan kedatangan mereka.

Tiket presale dijadwalkan dibuka pada 1 Februari 2025 melalui platform resmi. Kapasitas venue diperkirakan 15.000 penonton dan prediksi tiket akan habis dalam waktu sangat singkat.`,

  manga: `# One Piece Chapter 1110: Rahasia Kekuatan Joy Boy Akhirnya Terungkap!

Chapter terbaru One Piece yang dirilis Senin ini memecahkan rekor pembaca online terbanyak dalam sejarah manga Shonen Jump. Oda sensei mengungkap detail mengejutkan tentang kekuatan asli Joy Boy yang selama ini menjadi misteri terbesar dalam series ini.

Dalam chapter berjudul "The Will That Transcends Time", Nika (Luffy) berhadapan langsung dengan Gorosei Saturn dalam pertarungan yang mengguncang fondasi dunia One Piece. Kemampuan Gear Fifth yang baru diperlihatkan jauh melampaui ekspektasi para penggemar.

Editor Shonen Jump menyatakan bahwa chapter ini adalah turning point terbesar dalam 25 tahun sejarah One Piece. Komunitas manga global saat ini sedang ramai berdiskusi tentang implikasi dari revelasi besar tersebut.`,

  toys: `# Senyum Cerah Mekar Seperti Bunga! Osaki Tenka Shiny Colors Bertransformasi Jadi Figure Mewah Gardien Amethyst

Union Creative baru aja umumkan figure pre-painted completed skala 1/6 dari Osaki Tenka dalam kostum ikonik "Gardien Amethyst". Figur cantik ini bikin hati meleleh dengan senyum cerah yang mekar seperti bunga, lengkap dengan rambut fluffy mengembang dramatis. Pre-order udah dibuka di Rakuten Books seharga 31.928 yen (termasuk pajak), dengan harga referensi 33.000 yen. Kode produk UC002186-01, ukuran lebar 20 cm x tinggi 17,5 cm — pas banget buat display di rak koleksi premium kamu.

Detail craftsmanship-nya luar biasa, khas standar tinggi Union Creative yang sering muncul di event seperti Wonder Festival. Terbuat dari PVC dan ABS berkualitas, figure ini mereproduksi sempurna kostum Gardien Amethyst: bulu-bulu berlapis, aksesori rambut detail, hingga ekspresi wajah Tenka yang ceria khas karakter Illumination Stars di The Idolmaster Shiny Colors.

Buat fans iDOLM@STER atau kolektor figure anime premium, ini wajib masuk wishlist. Jadwal pengiriman estimasi akhir 2026. Jangan sampai ketinggalan pre-order sebelum slot habis!`,
};

const TEST_ARTICLE = TEST_ARTICLES[PILLAR] ?? TEST_ARTICLES['anime'];

// ── Output directory ──────────────────────────────────────────────────────────
const OUTPUT_DIR = path.resolve(__dirname, '../../../test-output');

// ── Logging ───────────────────────────────────────────────────────────────────
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

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║     Social Media Coordinator — Sandbox Test              ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  log(`Pillar:      ${PILLAR}`);
  log(`Image URL:   ${IMAGE_URL}`);
  log(`Skip vision: ${SKIP_VISION}`);
  log(`Output dir:  ${OUTPUT_DIR}`);

  // Create output dir
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    log(`Created output directory: ${OUTPUT_DIR}`);
  }

  // ── Step 1: Hook Copywriter ─────────────────────────────────────────────────
  separator('STEP 1 — Hook Copywriter');

  const copywriter = new HookCopywriter(log);
  log('Generating image_copy and caption…');

  const copywriterOutput = await copywriter.generate({
    articleMarkdown: TEST_ARTICLE,
    pillar:          PILLAR,
  });

  log(`✓ image_copy : "${copywriterOutput.image_copy}"`);
  log(`✓ caption    : "${copywriterOutput.caption}"`);

  // ── Step 2: Frame Generator ─────────────────────────────────────────────────
  separator('STEP 2 — Frame Generator');

  let postBuffer:  Buffer;
  let storyBuffer: Buffer;

  if (SKIP_VISION) {
    // Bypass Grok Vision — use centre focal point for fast local testing
    log('--skip-vision: using centre focal point (0.5, 0.4), skipping Grok Vision call');
    const result = await processImage({
      imageUrl:  IMAGE_URL,
      imageCopy: copywriterOutput.image_copy,
      pillar:    PILLAR,
      focalXPct: 0.5,
      focalYPct: 0.4,
    });
    postBuffer  = result.postBuffer;
    storyBuffer = result.storyBuffer;
  } else {
    log('Calling Grok Vision to identify focal point…');
    const frameGen = new FrameGenerator(log);
    const result = await frameGen.generate({
      featuredImageUrl: IMAGE_URL,
      imageCopy:        copywriterOutput.image_copy,
      pillar:           PILLAR,
    });
    postBuffer  = result.postBuffer;
    storyBuffer = result.storyBuffer;
  }

  log(`✓ Post buffer  : ${(postBuffer.length  / 1024).toFixed(1)} KB`);
  log(`✓ Story buffer : ${(storyBuffer.length / 1024).toFixed(1)} KB`);

  // ── Save images ─────────────────────────────────────────────────────────────
  separator('SAVING IMAGES');

  const timestamp    = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const postPath     = path.join(OUTPUT_DIR, `${PILLAR}-post-${timestamp}.png`);
  const storyPath    = path.join(OUTPUT_DIR, `${PILLAR}-story-${timestamp}.png`);

  fs.writeFileSync(postPath,  postBuffer);
  fs.writeFileSync(storyPath, storyBuffer);

  log(`✓ Post  saved → ${postPath}`);
  log(`✓ Story saved → ${storyPath}`);

  // ── Step 3: Adversarial Editor ──────────────────────────────────────────────
  separator('STEP 3 — Adversarial Editor (QA Review)');

  log('Sending rendered images to Grok Vision for QA review…');
  const editor  = new AdversarialEditor(log);
  const verdict = await editor.review({
    postImageBuffer:  postBuffer,
    storyImageBuffer: storyBuffer,
    caption:          copywriterOutput.caption,
    imageCopy:        copywriterOutput.image_copy,
  });

  log(`✓ Verdict : ${verdict.verdict}`);
  if (verdict.feedback_for_copywriter) {
    log(`  Copywriter feedback    : ${verdict.feedback_for_copywriter}`);
  }
  if (verdict.feedback_for_frame_generator) {
    log(`  Frame gen feedback     : ${verdict.feedback_for_frame_generator}`);
  }

  // ── Final summary ───────────────────────────────────────────────────────────
  separator('TEST COMPLETE');

  console.log('  📸  Output images:');
  console.log(`      Post  (1:1  1080×1080) → ${postPath}`);
  console.log(`      Story (9:16 1080×1920) → ${storyPath}`);
  console.log('');
  console.log('  📝  Copy:');
  console.log(`      image_copy : "${copywriterOutput.image_copy}"`);
  console.log(`      caption    : "${copywriterOutput.caption}"`);
  console.log('');
  console.log(`  🔍  Editor verdict : ${verdict.verdict === 'PASS' ? '✅ PASS' : '❌ FAIL'}`);
  console.log('');
}

main().catch((err) => {
  console.error('\n❌ Test failed:', err);
  process.exit(1);
});
