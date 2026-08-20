#!/usr/bin/env node
/* T1b fragment merge: fold fragments/g*-{en,zh}.json into locales/{en,zh-CN}.json.
 * Fails loudly on key collisions with differing values, then verifies parity. */
const fs = require('fs');
const path = require('path');

const FRAG = path.join(__dirname, '..', 'src', 'renderer', 'src', 'i18n', 'locales', 'fragments');
const LOC = path.join(__dirname, '..', 'src', 'renderer', 'src', 'i18n', 'locales');

function deepMerge(base, add, where) {
  for (const [k, v] of Object.entries(add)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if (!base[k] || typeof base[k] !== 'object' || Array.isArray(base[k])) base[k] = {};
      deepMerge(base[k], v, `${where}.${k}`);
    } else {
      if (k in base && base[k] !== undefined) {
        if (JSON.stringify(base[k]) !== JSON.stringify(v)) {
          throw new Error(`KEY COLLISION at ${where}.${k}: "${base[k]}" vs "${v}"`);
        }
        continue; // identical duplicate — fine
      }
      base[k] = v;
    }
  }
}

function keys(o, p = '') {
  return Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? keys(v, p + k + '.') : [p + k]));
}
function arrays(o, p = '') {
  const out = [];
  for (const [k, v] of Object.entries(o)) {
    const q = p + k;
    if (Array.isArray(v)) out.push([q, v.length]);
    else if (v && typeof v === 'object') out.push(...arrays(v, q + '.'));
  }
  return out;
}

const en = JSON.parse(fs.readFileSync(path.join(LOC, 'en.json'), 'utf8'));
const zh = JSON.parse(fs.readFileSync(path.join(LOC, 'zh-CN.json'), 'utf8'));
let merged = 0;
for (const f of fs.readdirSync(FRAG).filter((f) => f.endsWith('-en.json') || f.endsWith('-zh.json')).sort()) {
  const frag = JSON.parse(fs.readFileSync(path.join(FRAG, f), 'utf8'));
  const target = f.endsWith('-en.json') ? en : zh;
  for (const [ns, body] of Object.entries(frag)) {
    if (!target[ns]) target[ns] = {};
    deepMerge(target[ns], body, ns);
  }
  merged++;
}
fs.writeFileSync(path.join(LOC, 'en.json'), JSON.stringify(en, null, 2) + '\n');
fs.writeFileSync(path.join(LOC, 'zh-CN.json'), JSON.stringify(zh, null, 2) + '\n');

// parity check
const ek = new Set(keys(en)), zk = new Set(keys(zh));
const onlyEn = [...ek].filter((k) => !zk.has(k));
const onlyZh = [...zk].filter((k) => !ek.has(k));
if (onlyEn.length || onlyZh.length) {
  console.error('PARITY FAIL — onlyEn:', onlyEn, 'onlyZh:', onlyZh);
  process.exit(1);
}
const ea = arrays(en), za = arrays(zh);
for (const [p, n] of ea) {
  const m = za.find((x) => x[0] === p);
  if (!m || m[1] !== n) { console.error('ARRAY MISMATCH', p, n, m && m[1]); process.exit(1); }
}
console.log(`merged ${merged} fragment files; en/zh now ${ek.size} keys each, parity OK`);
