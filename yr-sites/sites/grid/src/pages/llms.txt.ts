import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import catalog from '../data/catalog.json';
import site from '../data/site.json';
import { llmsTxt } from '../../../../shared/site-lib.mjs';
export const GET: APIRoute = async ({ site: url }) => {
  const news = (await getCollection('news', (e) => e.data.status === 'published')).sort((a, b) => +b.data.date - +a.data.date).map((e) => ({ slug: e.id, title: e.data.title, description: e.data.description }));
  const pages = [
    { title: 'ROI calculator', path: '/calculator/', desc: 'Estimate solar size, investment and payback from a monthly bill and roof area' },
    { title: 'Solutions', path: '/solutions/', desc: 'Commercial solar + storage, EV charging hubs, solar carports, home backup' },
    { title: 'Partners', path: '/partners/', desc: 'Distributor, EPC, charging operator and OEM partnership' },
    { title: 'About', path: '/about/', desc: 'Company, credentials and project experience' },
    { title: 'Get a quote', path: '/contact/', desc: 'Instant reference price or formal PI' },
    { title: '中文站', path: '/zh/', desc: 'Chinese version of this site' },
  ];
  return new Response(llmsTxt({ site: url!.href, brand: site.brand, company: site.company, about: site.summary, catalog, pages, news, contact: { email: site.email } }), { headers: { 'content-type': 'text/plain; charset=utf-8' } });
};
