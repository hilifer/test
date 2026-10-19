import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import catalog from '../data/catalog.json';
import { sitemapXml } from '../../../../shared/site-lib.mjs';
export const GET: APIRoute = async ({ site: url }) => {
  const today = new Date();
  const pair = (path: string, lastmod: Date = today) => [
    { path, lastmod, alternates: [{ lang: 'en', path }, { lang: 'zh-CN', path: '/zh' + path }, { lang: 'x-default', path }] },
    { path: '/zh' + path, lastmod, alternates: [{ lang: 'en', path }, { lang: 'zh-CN', path: '/zh' + path }, { lang: 'x-default', path }] },
  ];
  const news = await getCollection('news', (e) => e.data.status === 'published');
  const entries = [
    ...['/', '/products/', '/solutions/', '/calculator/', '/partners/', '/about/', '/contact/', '/news/'].flatMap((p) => pair(p)),
    ...catalog.products.flatMap((p) => pair(`/products/${p.slug}/`)),
    { path: '/for-ai-agents/', lastmod: today },
    ...news.map((n) => ({ path: n.id.startsWith('zh/') ? `/zh/news/${n.id.slice(3)}/` : `/news/${n.id}/`, lastmod: n.data.updated || n.data.date })),
  ];
  return new Response(sitemapXml(url!.href, entries), { headers: { 'content-type': 'application/xml; charset=utf-8' } });
};
