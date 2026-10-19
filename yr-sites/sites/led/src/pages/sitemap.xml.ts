import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import catalog from '../data/catalog.json';
import { sitemapXml } from '../../../../shared/site-lib.mjs';
export const GET: APIRoute = async ({ site: url }) => {
  const news = await getCollection('news', (e) => e.data.status === 'published');
  const today = new Date();
  const entries = [
    ...['/', '/products/', '/solutions/', '/oem-odm/', '/certifications/', '/factory/', '/quote/', '/news/', '/for-ai-agents/', '/lighting-design/', '/wholesale/'].map((path) => ({ path, lastmod: today })),
    ...catalog.categories.map((c) => ({ path: `/${c.slug}/`, lastmod: today })),
    ...catalog.products.map((p) => ({ path: `/products/${p.slug}/`, lastmod: today })),
    ...news.map((n) => ({ path: `/news/${n.id}/`, lastmod: n.data.updated || n.data.date })),
  ];
  return new Response(sitemapXml(url!.href, entries), { headers: { 'content-type': 'application/xml; charset=utf-8' } });
};
