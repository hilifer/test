import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import catalog from '../data/catalog.json';
import site from '../data/site.json';
import { llmsTxt } from '../../../../shared/site-lib.mjs';
export const GET: APIRoute = async ({ site: url }) => {
  const news = (await getCollection('news', (e) => e.data.status === 'published')).sort((a, b) => +b.data.date - +a.data.date).map((e) => ({ slug: e.id, title: e.data.title, description: e.data.description }));
  const pages = [
    ...catalog.categories.map((c) => ({ title: c.title, path: `/${c.slug}/`, desc: `Buying guide, FAQ and all ${c.name.toLowerCase()} models` })),
    { title: 'Free lighting layout', path: '/lighting-design/', desc: 'Send a floor plan, get a photometric layout and fixture list' },
    { title: 'Wholesale and distributor program', path: '/wholesale/', desc: 'Volume pricing for contractors, distributor program, MAP policy' },
    { title: 'Solutions by application', path: '/solutions/', desc: 'Which fixtures to use for warehouses, parking lots, streets, sports fields, exteriors and indoor spaces' },
    { title: 'Certifications', path: '/certifications/', desc: 'DLC, UL/ETL, FCC, CE and RoHS by model' },
    { title: 'OEM and ODM', path: '/oem-odm/', desc: 'Private label and custom fixtures' },
    { title: 'Factory and company', path: '/factory/', desc: 'Manufacturing capabilities and quality checks' },
    { title: 'Get a quote', path: '/quote/', desc: 'Instant reference price or formal PI' },
  ];
  return new Response(llmsTxt({ site: url!.href, brand: site.brandFull, company: site.company, about: site.about, catalog, pages, news, contact: site.contact }), { headers: { 'content-type': 'text/plain; charset=utf-8' } });
};
