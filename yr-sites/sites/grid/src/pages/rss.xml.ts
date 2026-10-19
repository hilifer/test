import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import site from '../data/site.json';
import { rssXml } from '../../../../shared/site-lib.mjs';
export const GET: APIRoute = async ({ site: url }) => {
  const items = (await getCollection('news', (e) => e.data.status === 'published')).sort((a, b) => +b.data.date - +a.data.date).map((e) => ({ title: e.data.title, description: e.data.description, date: e.data.date, path: e.id.startsWith('zh/') ? `/zh/news/${e.id.slice(3)}/` : `/news/${e.id}/` }));
  return new Response(rssXml({ site: url!.href, title: `${site.brand} insights`, description: site.summary, items }), { headers: { 'content-type': 'application/rss+xml; charset=utf-8' } });
};
