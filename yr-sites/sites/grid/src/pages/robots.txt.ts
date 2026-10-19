import type { APIRoute } from 'astro';
import { robotsTxt } from '../../../../shared/site-lib.mjs';
export const GET: APIRoute = ({ site: url }) => new Response(robotsTxt(url!.href), { headers: { 'content-type': 'text/plain; charset=utf-8' } });
