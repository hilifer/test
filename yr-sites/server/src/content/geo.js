// GEO monitor: ask an AI answer engine the questions our buyers ask and record whether we
// are mentioned. Use a search-grounded model (e.g. Perplexity's OpenAI-compatible API) for
// results that reflect the live web; a plain model only reflects its training data.
import { config } from '../config.js';
import { complete } from '../llm.js';
import { db } from '../db.js';
import { logRun } from './store.js';

export async function runGeoCheck() {
  const g = config.profile.content.geo || {};
  const qs = g.questions || [];
  const llm = config.geo.llm.apiKey ? config.geo.llm : {};
  const names = [config.profile.brand, ...(g.brandAliases || [])].map((s) => s.toLowerCase());
  const comps = g.competitors || [];
  const results = [];
  for (const q of qs) {
    try {
      const answer = await complete({ system: 'Answer the buyer question helpfully and name specific suppliers or brands where relevant, with links if you have them.', user: q.q, maxTokens: 900, temperature: 0.2, llm });
      const low = answer.toLowerCase();
      const mentioned = names.some((n) => low.includes(n)) ? 1 : 0;
      const seen = comps.filter((c) => low.includes(c.toLowerCase()));
      db.prepare('INSERT INTO geo_checks (ts, question, lang, mentioned, competitors, answer, model) VALUES (?,?,?,?,?,?,?)').run(new Date().toISOString(), q.q, q.lang || 'en', mentioned, seen.join(', '), answer.slice(0, 4000), llm.model || config.llm.model);
      results.push({ q: q.q, mentioned, competitors: seen });
    } catch (e) { results.push({ q: q.q, error: e.message }); }
  }
  logRun('geo', 'ok', { asked: qs.length, mentioned: results.filter((r) => r.mentioned).length });
  return results;
}

export const geoHistory = (n = 100) => db.prepare('SELECT * FROM geo_checks ORDER BY id DESC LIMIT ?').all(n);
