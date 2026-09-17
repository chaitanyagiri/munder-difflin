#!/usr/bin/env node
/* Parity check for the Turkish locale: same key-paths as en.json, same
 * array lengths, same set of {{placeholder}} names per key. */
const fs = require('fs');
const path = require('path');

const LOC = path.join(__dirname, '..', 'src', 'renderer', 'src', 'i18n', 'locales');
const en = JSON.parse(fs.readFileSync(path.join(LOC, 'en.json'), 'utf8'));
const tr = JSON.parse(fs.readFileSync(path.join(LOC, 'tr.json'), 'utf8'));

function leaves(o, p = '') {
  const out = [];
  for (const [k, v] of Object.entries(o)) {
    const q = p ? `${p}.${k}` : k;
    if (Array.isArray(v)) out.push([q, 'array', v.length]);
    else if (v && typeof v === 'object') out.push(...leaves(v, q));
    else out.push([q, 'string', v]);
  }
  return out;
}

const enLeaves = leaves(en);
const trLeaves = leaves(tr);
const enMap = new Map(enLeaves.map((l) => [l[0], l]));
const trMap = new Map(trLeaves.map((l) => [l[0], l]));

const onlyEn = [...enMap.keys()].filter((k) => !trMap.has(k));
const onlyTr = [...trMap.keys()].filter((k) => !enMap.has(k));

let fail = false;
if (onlyEn.length) { fail = true; console.error('MISSING IN tr.json:', onlyEn); }
if (onlyTr.length) { fail = true; console.error('EXTRA IN tr.json (not in en.json):', onlyTr); }

for (const [key, kind, val] of enLeaves) {
  const trEntry = trMap.get(key);
  if (!trEntry) continue;
  if (kind === 'array' && trEntry[1] === 'array' && trEntry[2] !== val) {
    fail = true;
    console.error(`ARRAY LENGTH MISMATCH at ${key}: en=${val} tr=${trEntry[2]}`);
  }
  if (kind === 'string' && trEntry[1] === 'string') {
    const enPh = new Set((String(val).match(/\{\{\s*[\w.]+\s*\}\}/g) || []).map((s) => s.replace(/\s+/g, '')));
    const trPh = new Set((String(trEntry[2]).match(/\{\{\s*[\w.]+\s*\}\}/g) || []).map((s) => s.replace(/\s+/g, '')));
    const missing = [...enPh].filter((p) => !trPh.has(p));
    const extra = [...trPh].filter((p) => !enPh.has(p));
    if (missing.length || extra.length) {
      fail = true;
      console.error(`PLACEHOLDER MISMATCH at ${key}: en="${val}" tr="${trEntry[2]}" missing=${JSON.stringify(missing)} extra=${JSON.stringify(extra)}`);
    }
  }
}

if (fail) {
  console.error(`\nFAIL — ${onlyEn.length} missing, ${onlyTr.length} extra keys, plus any mismatches above.`);
  process.exit(1);
} else {
  console.log(`OK — ${enLeaves.length} keys match between en.json and tr.json (structure + placeholders).`);
}
