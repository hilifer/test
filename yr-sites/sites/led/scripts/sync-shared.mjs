// Copies the shared chat widget + rule engine into public/ so the site is self-contained.
import { cpSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = new URL('../../../shared/', import.meta.url);
const out = new URL('../public/assets/', import.meta.url);
mkdirSync(out, { recursive: true });
for (const f of ['chat-widget.js', 'sales-engine.js', 'quote-list.js']) cpSync(fileURLToPath(new URL(f, root)), fileURLToPath(new URL(f, out)));
console.log('synced shared assets');
