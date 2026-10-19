import type { APIRoute } from 'astro';
import catalog from '../../data/catalog.json';
import site from '../../data/site.json';
import { productMarkdown } from '../../../../../shared/site-lib.mjs';
export function getStaticPaths() { return catalog.products.map((p) => ({ params: { slug: p.slug }, props: { p } })); }
export const GET: APIRoute = ({ props, site: url }) => new Response(productMarkdown({ site: url!.href, brand: site.brand, catalog, p: props.p }), { headers: { 'content-type': 'text/markdown; charset=utf-8' } });
