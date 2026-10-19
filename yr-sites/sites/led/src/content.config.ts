import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';
// NEWS_DIR lets production keep articles on a persistent volume written by the content agent.
const news = defineCollection({
  loader: glob({ pattern: '**/*.md', base: process.env.NEWS_DIR || './src/content/news' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    date: z.coerce.date(),
    updated: z.coerce.date().optional(),
    status: z.enum(['draft', 'published', 'rejected']).default('draft'),
    lang: z.string().default('en'),
    tags: z.array(z.string()).default([]),
    products: z.array(z.string()).default([]),
    faq: z.array(z.object({ q: z.string(), a: z.string() })).default([]),
    sources: z.array(z.object({ title: z.string(), url: z.string() })).default([]),
    author: z.string().default('Editorial team'),
    generatedBy: z.string().optional(),
  }),
});
export const collections = { news };
