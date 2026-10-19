import type { APIRoute } from 'astro';
import catalog from '../data/catalog.json';
import { publicCatalog } from '../../../../shared/sales-engine.js';
// Public catalog (also used by the chat widget in offline mode). Contains no cost data; no prices at all when priceDisplay = hidden.
export const GET: APIRoute = () => new Response(JSON.stringify(publicCatalog(catalog)), { headers: { 'content-type': 'application/json; charset=utf-8' } });
