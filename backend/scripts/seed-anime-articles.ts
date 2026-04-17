import dotenv from 'dotenv';
dotenv.config();
process.env.DATABASE_URL = 'file:./prisma/dev.db';

import { PrismaClient } from '@prisma/client';

async function main() {
  const p = new PrismaClient();

  await p.article.create({ data: {
    title:       'Gintama x Pui Pui Molcar Pop-Up Store Dibuka di Tokyo',
    pillar:      'anime',
    sourceUrl:   'https://www.animenewsnetwork.com/news/2026-04-17/gintama-pui-pui-molcar-popup/.209174',
    status:      'PUBLISHED',
    content:     'Kolaborasi unik antara Gintama dan Pui Pui Molcar hadir dalam pop-up store eksklusif di Tokyo.',
    contentHtml: '<p>Kolaborasi unik antara Gintama dan Pui Pui Molcar hadir dalam pop-up store eksklusif di Tokyo.</p>',
    images: JSON.stringify([{
      url:        'https://www.animenewsnetwork.com/thumbnails/crop400x200/cms/news/209174/gintama.jpg',
      alt:        'Gintama x Pui Pui Molcar Pop-Up',
      isFeatured: true,
    }]),
    wpPostId:  6159,
    wpPostUrl: 'https://hotpink-dogfish-392833.hostingersite.com/gintama-pui-pui-molcar-popup/',
  }});

  await p.article.create({ data: {
    title:       "Film Anime L'étoile de Paris en fleur Tayangkan 11 Menit Pertama",
    pillar:      'anime',
    sourceUrl:   'https://www.animenewsnetwork.com/news/2026-04-17/etoile-de-paris-en-fleur-anime-film/.209175',
    status:      'PUBLISHED',
    content:     "Film anime L'étoile de Paris en fleur merilis 11 menit pertama untuk memikat penonton global.",
    contentHtml: "<p>Film anime L'étoile de Paris en fleur merilis 11 menit pertama secara online.</p>",
    images: JSON.stringify([{
      url:        'https://www.animenewsnetwork.com/thumbnails/crop400x200/cms/news/209175/etoile.jpg',
      alt:        "L'étoile de Paris en fleur",
      isFeatured: true,
    }]),
    wpPostId:  6160,
    wpPostUrl: "https://hotpink-dogfish-392833.hostingersite.com/etoile-de-paris-anime/",
  }});

  const count = await p.article.count({ where: { status: 'PUBLISHED', pillar: 'anime' } });
  console.log(`Published anime articles: ${count}`);
  await p.$disconnect();
}

main().catch(console.error);
