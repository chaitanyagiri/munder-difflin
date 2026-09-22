import type { AccentColorName } from '@/design/tokens';

export interface CastMember {
  id: string;
  name: string;
  role: string;
  accent: AccentColorName;
  glyph: string;
  isHuman: boolean;
  isSystem: boolean;
}

const CAST: Record<string, { role: string; accent: AccentColorName }> = {
  michael: { role: 'Regional Manager', accent: 'lilac' },
  dwight: { role: 'Risk Governance', accent: 'coral' },
  toby: { role: 'Market Integrity', accent: 'sky' },
  phyllis: { role: 'Public Research', accent: 'mint' },
  meredith: { role: 'Public Research', accent: 'mint' },
  jim: { role: 'Microstructure', accent: 'lemon' },
  kevin: { role: 'Pattern Recognition', accent: 'lemon' },
  pam: { role: 'Front Desk', accent: 'peach' },
  ryan: { role: 'Social Radar', accent: 'peach' },
  oscar: { role: 'Bayesian Engine', accent: 'lilac' },
  angela: { role: 'Coherence', accent: 'mint' },
  creed: { role: 'Red Team', accent: 'coral' },
  devin: { role: 'Forecaster', accent: 'sky' },
  stanley: { role: 'Sales', accent: 'lemon' },
  andy: { role: 'Sales', accent: 'peach' },
  kelly: { role: 'Customer Service', accent: 'lilac' },
  darryl: { role: 'Warehouse', accent: 'sky' },
  god: { role: 'Orchestrator', accent: 'lilac' },
  scheduler: { role: 'PA System', accent: 'sky' },
  system: { role: 'System', accent: 'sky' },
};

const ACCENTS: AccentColorName[] = ['coral', 'mint', 'sky', 'lemon', 'lilac', 'peach'];

function hashAccent(key: string): AccentColorName {
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return ACCENTS[h % ACCENTS.length];
}

function baseKey(id: string): string {
  const m = /^worker-([a-z]+)/i.exec(id);
  const key = (m ? m[1] : id).toLowerCase();
  return key === 'god' ? 'michael' : key;
}

function titleCase(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

const cache = new Map<string, CastMember>();

export function castFor(id: string): CastMember {
  const hit = cache.get(id);
  if (hit) return hit;
  let member: CastMember;
  if (id === 'human') {
    member = { id, name: 'You', role: 'Owner', accent: 'sky', glyph: '★', isHuman: true, isSystem: false };
  } else {
    const key = baseKey(id);
    const known = CAST[key];
    const name = titleCase(key);
    member = {
      id,
      name,
      role: known?.role ?? 'Worker',
      accent: known?.accent ?? hashAccent(key),
      glyph: name.slice(0, 2),
      isHuman: false,
      isSystem: key === 'scheduler' || key === 'system',
    };
  }
  cache.set(id, member);
  return member;
}

export type MessageKind = 'whale' | 'fill' | 'settle' | 'standup' | 'desk' | 'research' | 'plain';

export interface MessageRead {
  kind: MessageKind;
  outcome: 'win' | 'loss' | null;
  headline: string | null;
}

const MONEY = /\$\s?\d[\d,]*(?:\.\d+)?/g;

function biggestAmount(text: string): string | null {
  let best: { value: number; text: string } | null = null;
  for (const m of text.matchAll(MONEY)) {
    const value = Number(m[0].replace(/[^0-9.]/g, ''));
    if (!Number.isFinite(value)) continue;
    if (!best || value > best.value) best = { value, text: m[0].replace(/\s/g, '') };
  }
  return best?.text ?? null;
}

export function readMessage(from: string, subject: string, body: string): MessageRead {
  const s = subject.toLowerCase();
  const b = body.toLowerCase();
  const who = baseKey(from);
  if (who === 'scheduler' || who === 'system' || s.includes('standup')) {
    return { kind: 'standup', outcome: null, headline: null };
  }
  if (s.includes('whale') || b.includes('size just moved')) {
    return { kind: 'whale', outcome: null, headline: biggestAmount(body) };
  }
  if (s.includes('settle') || b.includes('settled ') || b.includes('settlement')) {
    const win = /\bwon\b|profit|\+\$|paid out/.test(b);
    const loss = /\blost\b|\bloss\b|-\$|expired worthless/.test(b);
    return { kind: 'settle', outcome: win && !loss ? 'win' : loss ? 'loss' : null, headline: biggestAmount(body) };
  }
  if (/\bfill(?:ed|s)?\b|order (?:placed|submitted|filled)|bought \d+|sold \d+/.test(b) || s.includes('fill') || s.includes('order')) {
    return { kind: 'fill', outcome: null, headline: biggestAmount(body) };
  }
  if (s.includes('front desk')) return { kind: 'desk', outcome: null, headline: null };
  if (/research|forecast|evidence|probability/.test(s)) return { kind: 'research', outcome: null, headline: null };
  return { kind: 'plain', outcome: null, headline: null };
}

export const KIND_LABEL: Record<MessageKind, string | null> = {
  whale: 'Whale print',
  fill: 'Order',
  settle: 'Settlement',
  standup: 'PA system',
  desk: 'Front desk',
  research: 'Research',
  plain: null,
};
