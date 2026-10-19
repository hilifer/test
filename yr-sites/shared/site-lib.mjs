// Machine-readable layer shared by both sites: product Markdown, llms.txt, RSS, JSON-LD.
// "Make the site readable by buyers' AI agents" — every page has a clean Markdown twin.

export const abs = (site, path) => new URL(path, site).href;
const hidden = (catalog) => catalog?.priceDisplay === 'hidden';

export function priceLine(catalog, p) {
  if (!p.priceBands?.length) return 'On request';
  const lo = Math.min(...p.priceBands.map((b) => b.low));
  const hi = Math.max(...p.priceBands.map((b) => b.high));
  return `${catalog.currency} ${lo.toLocaleString('en-US')}–${hi.toLocaleString('en-US')} per ${singular(p.unit)} (${catalog.priceTerm})`;
}
const singular = (u = 'pcs') => (u === 'pcs' ? 'pc' : u.replace(/s$/, '').replace(/s \(/, ' ('));

export function productMarkdown({ site, brand, catalog, p, lang = 'en' }) {
  const zh = lang === 'zh';
  const name = zh && p.nameZh ? p.nameZh : p.name;
  const summary = zh && p.summaryZh ? p.summaryZh : p.summary;
  const hl = zh && p.highlightsZh ? p.highlightsZh : p.highlights || [];
  const cat = catalog.categories.find((c) => c.id === p.category);
  const lines = [
    `# ${name}`,
    '',
    `> ${summary}`,
    '',
    `- Brand: ${brand}`,
    `- Model: ${p.id}`,
    `- Category: ${cat ? cat.name : p.category}`,
    `- Page: ${abs(site, `/products/${p.slug}/`)}`,
    '',
    '## Key points',
    ...hl.map((h) => `- ${h}`),
    '',
    '## Specifications',
    '',
    '| Item | Value |',
    '| --- | --- |',
    ...Object.entries(p.specs).map(([k, v]) => `| ${k} | ${v} |`),
    '',
    '## Certifications',
    p.certifications.map((c) => `- ${c}`).join('\n'),
    '',
    '## Ordering',
    `- MOQ: ${p.moq} ${p.unit || 'pcs'}`,
    `- Production lead time: ${p.leadTimeDays[0]}–${p.leadTimeDays[1]} days`,
    `- Samples: ${p.sampleDays[0]}–${p.sampleDays[1]} days`,
    `- Warranty: ${p.warranty}`,
    '',
    ...(hidden(catalog)
      ? ['## Price', '', `Quoted per project (${catalog.priceTerm}) based on quantity, configuration and destination. Request a quotation below.`]
      : [
          `## Reference price (${catalog.currency}, ${catalog.priceTerm})`,
          '',
          '| Quantity | Unit price |',
          '| --- | --- |',
          ...(p.priceBands || []).map((b) => `| ${b.minQty}${b.maxQty ? '–' + b.maxQty : '+'} ${p.unit || 'pcs'} | ${b.low.toLocaleString('en-US')}–${b.high.toLocaleString('en-US')} |`),
          '',
          `${catalog.priceNote} Freight not included.`,
        ]),
    '',
    '## How to buy',
    `- Ask the AI sales assistant on ${abs(site, '/')} ${hidden(catalog) ? 'about specifications and lead times' : 'for an instant reference quote'}, or`,
    `- Request a formal quotation (PI): ${abs(site, '/quote/')}`,
    `- AI agents: MCP endpoint ${abs(site, '/mcp')} (tools: search_products, get_product, estimate_quote, submit_inquiry)`,
  ];
  if (catalog.sample) lines.push('', '_Note: preview build — specifications and prices are sample data._');
  return lines.join('\n') + '\n';
}

export function llmsTxt({ site, brand, company, about, catalog, pages, news = [], contact }) {
  const out = [
    `# ${brand}`,
    '',
    `> ${about}`,
    '',
    `${brand} is operated by ${company.replace(/\.$/, "")}. ${hidden(catalog) ? `Prices are quoted per project (${catalog.priceTerm}); a formal Proforma Invoice (PI) is issued by a sales engineer.` : `Prices on this site are public reference ranges (${catalog.currency}, ${catalog.priceTerm}); a formal Proforma Invoice (PI) is issued by a sales engineer.`} Every product page has a Markdown version (append .md to the product URL without the trailing slash).`,
    '',
    '## How to get a quote',
    `- Instant reference price: AI sales assistant on any page (24/7)`,
    `- Formal quotation: ${abs(site, '/quote/')}`,
    `- MCP server for AI agents: ${abs(site, '/mcp')} — tools: search_products, get_product, estimate_quote, submit_inquiry`,
    `- Full catalog as JSON: ${abs(site, '/products.json')}`,
    contact?.email ? `- Email: ${contact.email}` : '',
    '',
    '## Products',
  ];
  for (const c of catalog.categories) {
    out.push('', `### ${c.name}`, c.blurb ? c.blurb : '');
    for (const p of catalog.products.filter((x) => x.category === c.id))
      out.push(`- [${p.name}](${abs(site, `/products/${p.slug}.md`)}): ${p.summary} MOQ ${p.moq} ${p.unit || 'pcs'}. ${p.certifications.join(', ')}.`);
  }
  out.push('', '## Company', ...pages.map((pg) => `- [${pg.title}](${abs(site, pg.path)}): ${pg.desc}`));
  if (news.length) {
    out.push('', '## Articles');
    for (const n of news.slice(0, 30)) out.push(`- [${n.title}](${abs(site, `/news/${n.slug}.md`)}): ${n.description}`);
  }
  out.push('', '## Optional', `- [Full product details in one file](${abs(site, '/llms-full.txt')})`);
  return out.filter((l) => l !== null).join('\n') + '\n';
}

export function llmsFull({ site, brand, catalog }) {
  return [`# ${brand} — full catalog`, '', ...catalog.products.map((p) => productMarkdown({ site, brand, catalog, p }).replace(/^# /, '## ').replace(/\n## /g, '\n### '))].join('\n\n');
}

export function productJsonLd({ site, brand, catalog, p, lang = 'en' }) {
  const lo = p.priceBands?.length && !hidden(catalog) ? Math.min(...p.priceBands.map((b) => b.low)) : undefined;
  const hi = p.priceBands?.length ? Math.max(...p.priceBands.map((b) => b.high)) : undefined;
  return {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: lang === 'zh' && p.nameZh ? p.nameZh : p.name,
    sku: p.id,
    mpn: p.id,
    brand: { '@type': 'Brand', name: brand },
    description: lang === 'zh' && p.summaryZh ? p.summaryZh : p.summary,
    url: abs(site, `/products/${p.slug}/`),
    category: catalog.categories.find((c) => c.id === p.category)?.name,
    additionalProperty: Object.entries(p.specs).map(([name, value]) => ({ '@type': 'PropertyValue', name, value })),
    ...(lo != null && {
      offers: {
        '@type': 'AggregateOffer',
        priceCurrency: catalog.currency,
        lowPrice: lo,
        highPrice: hi,
        eligibleQuantity: { '@type': 'QuantitativeValue', minValue: p.moq, unitText: p.unit || 'pcs' },
        availability: 'https://schema.org/InStock',
        businessFunction: 'http://purl.org/goodrelations/v1#Sell',
      },
    }),
  };
}

export function faqJsonLd(faq) {
  if (!faq?.length) return null;
  return { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: faq.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })) };
}

const x = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);
export function rssXml({ site, title, description, items, lang = 'en' }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel>
<title>${x(title)}</title><link>${abs(site, '/')}</link><description>${x(description)}</description><language>${lang}</language>
<atom:link href="${abs(site, '/rss.xml')}" rel="self" type="application/rss+xml"/>
${items.map((i) => `<item><title>${x(i.title)}</title><link>${abs(site, i.path)}</link><guid>${abs(site, i.path)}</guid><pubDate>${new Date(i.date).toUTCString()}</pubDate><description>${x(i.description)}</description></item>`).join('\n')}
</channel></rss>`;
}

export function sitemapXml(site, entries) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${entries.map((e) => `<url><loc>${abs(site, e.path)}</loc>${e.lastmod ? `<lastmod>${new Date(e.lastmod).toISOString().slice(0, 10)}</lastmod>` : ''}${(e.alternates || []).map((a) => `<xhtml:link rel="alternate" hreflang="${a.lang}" href="${abs(site, a.path)}"/>`).join('')}</url>`).join('\n')}
</urlset>`;
}

export function robotsTxt(site) {
  // AI crawlers explicitly welcome: being read by them is the point (GEO).
  return `User-agent: *
Allow: /
Disallow: /admin
Disallow: /api/

User-agent: GPTBot
Allow: /
User-agent: OAI-SearchBot
Allow: /
User-agent: ChatGPT-User
Allow: /
User-agent: ClaudeBot
Allow: /
User-agent: Claude-SearchBot
Allow: /
User-agent: PerplexityBot
Allow: /
User-agent: Google-Extended
Allow: /
User-agent: Bingbot
Allow: /

Sitemap: ${abs(site, '/sitemap.xml')}
# LLM guide: ${abs(site, '/llms.txt')}
`;
}

export function newsMarkdown({ site, entry }) {
  const d = entry.data;
  return [`# ${d.title}`, '', `> ${d.description}`, '', `Published: ${new Date(d.date).toISOString().slice(0, 10)} · URL: ${abs(site, `/news/${entry.id}/`)}`, '', entry.body || '', d.faq?.length ? '\n## FAQ\n' + d.faq.map((f) => `**${f.q}**\n\n${f.a}`).join('\n\n') : '', d.sources?.length ? '\n## Sources\n' + d.sources.map((s) => `- [${s.title}](${s.url})`).join('\n') : ''].join('\n') + '\n';
}
