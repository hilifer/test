// Company/brand data for documents (PI, portal), read from the site's own site.json.
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { getSetting } from '../catalog/store.js';
const here = dirname(fileURLToPath(import.meta.url));
// Contact details are edited in the admin (站点设置) and stored in the database; the site.json file is the fallback.
export function brand() {
  const s = getSetting('site') || JSON.parse(readFileSync(process.env.SITE_JSON || resolve(here, `../../../sites/${config.site}/src/data/site.json`), 'utf8'));
  const c = s.contact || {};
  return {
    brand: s.brandFull || s.brand,
    company: s.company,
    companyZh: s.companyZh || '深圳市耀嵘科技有限公司',
    email: c.email || s.email,
    whatsapp: c.whatsapp || s.whatsapp,
    address: c.address || s.address,
    // Bank details go in site.json → "bank": { "beneficiary", "bank", "account", "swift", "address" }
    bank: s.bank || null,
    accent: config.site === 'grid' ? '#12202a' : '#14202e',
    accent2: config.site === 'grid' ? '#c8e03c' : '#ffb000',
    logo: config.site === 'grid' ? '/brand/yr-grid-logo-160.webp' : '/favicon.svg',
  };
}
