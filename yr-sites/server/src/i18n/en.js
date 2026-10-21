// English for the admin UI: Chinese fragment → English. Status labels come from the shared data dictionary.
import p1 from './en-1.js';
import p2 from './en-2.js';
import p3 from './en-3.js';
import p4 from './en-4.js';
import p5 from './en-5.js';
import p6 from './en-6.js';
import p7 from './en-7.js';
import p8 from './en-8.js';
import p9 from './en-9.js';
import p10 from './en-10.js';
import { DICT } from '../../../shared/dictionary.js';

const fromDict = {};
for (const ent of Object.values(DICT)) {
  if (Array.isArray(ent)) for (const v of ent) if (v && v.zh && v.en) fromDict[v.zh] = v.en; // e.g. paymentTerms
  for (const group of Object.values(ent || {})) {
    if (!group || typeof group !== 'object') continue;
    for (const v of Array.isArray(group) ? group : Object.values(group)) if (v && v.zh && v.en) fromDict[v.zh] = v.en;
  }
}
export const EN = { ...fromDict, ...p1, ...p2, ...p3, ...p4, ...p5, ...p6, ...p7, ...p8, ...p9, ...p10 };
