import type { APIRoute } from 'astro';
import catalog from '../data/catalog.json';
import site from '../data/site.json';
import { llmsFull } from '../../../../shared/site-lib.mjs';
export const GET: APIRoute = ({ site: url }) => new Response(llmsFull({ site: url!.href, brand: site.brandFull, catalog }), { headers: { 'content-type': 'text/plain; charset=utf-8' } });
