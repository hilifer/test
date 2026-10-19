import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import { newsMarkdown } from '../../../../../shared/site-lib.mjs';
export async function getStaticPaths() { return (await getCollection('news', (e) => e.data.status === 'published')).map((entry) => ({ params: { slug: entry.id }, props: { entry } })); }
export const GET: APIRoute = ({ props, site: url }) => new Response(newsMarkdown({ site: url!.href, entry: props.entry }), { headers: { 'content-type': 'text/markdown; charset=utf-8' } });
