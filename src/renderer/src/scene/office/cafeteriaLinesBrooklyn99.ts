// Brooklyn Nine-Nine floor flavour — the precinct edition of the office's
// cafeteria quips, boss gossip, suck-up lines, cheers and errand mutters.
//
// Agents keep their OfficeCharacterName even under the B99 theme (the cast layer
// reskins them — michael=Holt, jim=Jake, pam=Amy, oscar=Rosa, kevin=Charles;
// dwight=Terry; idle/archived=Hitchcock/Scully), so every line pool here is
// keyed by the SAME office key the floor passes in. The whole bundle is handed
// to the scene as BROOKLYN99_THEME.flavor; the office theme leaves `flavor`
// undefined and keeps its own in-file constants byte-for-byte.

import type { OfficeCharacterName } from './cast';
import type { BreakSpot } from './cafeteriaLines';
import type { ErrandKind } from './themeRegistry';

const pick = <T,>(arr: readonly T[], seed: number): T =>
  arr[((seed % arr.length) + arr.length) % arr.length];

// ─── errand mutters (interrogate / file-evidence / Terry-yogurt / perp-walk) ──
//
// Mapped onto the existing errand mechanics (Oscar's stand/fx coords drive the
// animation; only the muttered line changes): fridge → Terry's yogurt, shelf →
// filing evidence, bin → perp-walk, dispenser/window → interrogation/casing,
// smoke → Holt brooding (god-only, in his glass office).
const B99_ERRAND_THOUGHTS: Record<ErrandKind, readonly string[]> = {
  water:     ['watering the precinct plants 🌿', 'someone has to', 'they outlive the cases'],
  window:    ['casing the street 🔎', 'a perp could be anywhere', 'eyes on the block'],
  dispenser: ['interrogation room hydration 💧', 'good cop needs water', 'staying sharp for the box'],
  fridge:    ['WHO TOOK MY YOGURT?', 'Terry needs his yogurt', 'these yogurts are LABELED'],
  shelf:     ['filing this evidence 🗂️', 'logging the case file', 'chain of custody, people'],
  bin:       ['perp walk for the scrap paper 🚔', "book 'em", 'case closed, in the bin'],
  smoke:     ['the precinct runs itself', '...', 'I had a different reaction.', 'thinking about Wuntch 🚬'],
};

// ─── boss aura: Captain Holt edition ─────────────────────────────────────────
//
// Indices 0–1 carry `{done}` (shown only when the worker has shipped tasks);
// 2+ are generic — the scene slices [2:] when done is 0, so keep that order.
const B99_SUCK_UP_LINES: readonly string[] = [
  'closed {done} cases, Captain. commendation? 🫡',
  '{done} cases cleared this week, sir!',
  'your leadership is an inspiration, Captain.',
  'I was JUST about to do exactly that, sir!',
  'sharp suit today, Captain Holt.',
  'working hard, Captain! 💪',
  'finest captain the Nine-Nine has had.',
];

const B99_GOSSIP_LINES: readonly string[] = [
  'does he ever actually blink?',
  'he said "hot damn" once. ONCE.',
  'I think Cheddar runs this precinct',
  'he gave me a "satisfactory." I cried.',
  'the Wuntch thing again, honestly…',
  'he color-codes his color-coding',
  'pretty sure he dreams in spreadsheets',
];

const B99_CHEER_LINES: readonly string[] = [
  'noice 😎', 'cool cool cool', 'case closed', 'toit nups', 'book it',
  'BINGPOT!', 'another one for the board',
];

// ─── cafeteria solo lines ────────────────────────────────────────────────────

const COFFEE: readonly string[] = [
  'precinct coffee. an acquired tolerance.',
  "we're out of the good creamer again",
  'this mug says "World’s Okayest Detective"',
  'first cup of the stakeout. and the fifth.',
  'Amy made a fresh pot. she labeled it.',
  'who took my mug? I have suspects.',
];

const VENDING: readonly string[] = [
  'the machine ate my badge money',
  'B4… please be the gummy worms',
  "it's stuck. I'll note it in the report.",
  'shaking it down. gently. it has rights.',
  'one (1) emotional-support snack',
  'A1 again. living dangerously.',
];

const SNACK: readonly string[] = [
  'is it Halloween Heist season?',
  'who finished the evidence-room pretzels??',
  'just a little treat between cases',
  'these are the bullpen’s? cool cool',
  'second breakfast, detective business',
];

const TABLE: readonly string[] = [
  'big day. lots of paperwork.',
  'just five more minutes off the clock',
  'did you read the briefing notes?',
  'pretending to review the case file',
  'I needed this break, honestly',
  'do NOT tell the Captain I’m in here',
];

const SPOT_POOL: Record<BreakSpot, readonly string[]> = {
  coffee: COFFEE, vending: VENDING, snack: SNACK, table: TABLE,
};

// Character flavour, keyed by the OFFICE key the floor passes (the cast layer
// reskins it). michael=Holt, jim=Jake, pam=Amy, oscar=Rosa, kevin=Charles,
// dwight=Terry; the rest are Hitchcock/Scully comic relief.
const BY_CHARACTER: Partial<Record<OfficeCharacterName, readonly string[]>> = {
  michael:  ['Hot damn.', 'I am not interested in being liked.', 'Wuntch.', 'everything is on fire. (deadpan)', 'I had a wonderful time. that was sarcasm.'],
  jim:      ['cool cool cool cool', 'noice 😎', 'title of your- nope, HR.', 'this is the BEST day', 'I am a genius detective'],
  pam:      ['I have a binder for that', 'perfect attendance, perfect grade', 'the Captain noticed my work!', '8 hours sleep, fully hydrated', 'I love a good wall chart'],
  oscar:    ['don’t.', 'I have 37 knives. unrelated.', 'I don’t discuss my personal life', 'cool. whatever. fine.'],
  kevin:    ['JAKEY!', 'I made a stew for the bullpen', 'best friend slash detective slash genius', 'for Nikolaj', 'this is my best friend'],
  dwight:   ['these yogurts are LABELED, people', 'Terry loves yogurt', 'Terry needs his calcium', 'do not test the Sarge'],
  angela:   ['I’m basically retired', 'is it lunch yet?', 'we solved a case once. I think.'],
  stanley:  ['almost lunchtime', 'I’ve been shot. twice.', 'just resting my eyes'],
  phyllis:  ['is it lunch yet?', 'I’ll get to the report. eventually.'],
  andy:     ['we cracked a case in ’85', 'or was it ’86? doesn’t matter.'],
  kelly:    ['okay so the BRIEFING, right—', 'so much precinct drama today'],
  ryan:     ['I’m kind of a big deal at the Nine-Nine', 'the new guy needs caffeine'],
  toby:     ['HR-wise, this break is approved', 'no one sits with me in the break room'],
  creed:    ['which detective are you again?', 'I’ve seen things in that evidence room'],
  meredith: ['is it 5 o’clock yet?', 'who spiked the precinct coffee?'],
};

/** A solo break-room line — character flavour ~60% of the time, else a line
 *  that fits the spot. Mirrors the office pickSoloLine signature/seeding. */
export function pickSoloLineB99(character: string, spot: BreakSpot, seed: number): string {
  const flavour = BY_CHARACTER[character as OfficeCharacterName];
  if (flavour && seed % 5 < 3) return pick(flavour, Math.floor(seed / 5));
  return pick(SPOT_POOL[spot], seed);
}

// ─── paired exchanges (two detectives at one table) ──────────────────────────
//
// Beats alternate: index 0 = the detective who sat down, 1 = their table-mate.

type Exchange = readonly string[];

// Generic precinct banter — works between any two detectives.
const EXCHANGES: readonly Exchange[] = [
  ['cool cool cool.', 'no doubt no doubt.', 'cool.'],
  ['title of your sex tape.', '...we are at WORK.', 'still counts.'],
  ['BINGPOT.', 'that’s not— you said it wrong.', 'BINGPOT.'],
  ['I have a theory about the case.', 'is it aliens again?', '...maybe.'],
  ['name a better detective. you can’t.', 'Holt.', '...okay, two.'],
  ['I labeled the whole evidence room.', 'I know. thank you, Amy.'],
  ['who keeps eating my yogurt?', 'not me, Sarge.', 'TERRY IS WATCHING.'],
  ['I don’t want to talk about it.', 'about what?', 'exactly.'],
  ['Jakey, I made you a stew!', 'Boyle, it’s 9am.', 'soup is breakfast.'],
  ['everything is on fire.', 'that’s the spirit.', 'I was being literal.'],
  ['Halloween Heist this year?', 'I will destroy you all.', 'cool cool cool.'],
  ['did you file the paperwork?', '...define filed.', 'Amy is going to cry.'],
  ['I have 37 knives.', 'why are you telling me?', 'no reason.'],
  ['the Captain smiled today.', 'he did NOT.', 'a corner of his mouth moved.'],
  ['noice.', 'smort.', 'we really are detectives.'],
  ['is a hot dog a sandwich, legally?', 'take it to the box.', 'I’ll get a confession.'],
  ['Cheddar is a better cop than us.', 'agreed.', 'don’t tell the Captain.'],
  ['I’ve been shot. twice.', 'we know, Scully.', 'just saying. lunch?'],
  ['vested. revested. unvested.', 'what does that mean?', 'I look great.'],
  ['ma’am, this is a precinct.', 'I work here.', 'still suspicious.'],
];

// Keyed off the SPEAKER so the right detective opens with their bit.
const KEYED_EXCHANGES: Partial<Record<OfficeCharacterName, Exchange>> = {
  michael:  ['Hot damn.', '...sir?', 'that is all.'],          // Holt
  jim:      ['cool cool cool.', 'you said cool four times.', 'cool.'],   // Jake
  pam:      ['I made a binder for the binders.', '...of course you did.'],   // Amy
  oscar:    ['don’t.', 'I didn’t say anything.', 'good.'],   // Rosa
  kevin:    ['best friends share everything.', 'please stop.', 'a beautiful friendship.'],   // Boyle
  dwight:   ['these are Terry’s yogurts.', 'nobody touched them, Sarge.', 'TERRY remembers.'],   // Terry
  stanley:  ['is it lunch?', 'no, Scully.', '...I’ll wait.'],
};

/** A multi-beat exchange for two detectives sharing a table. Beats alternate:
 *  index 0 = `speaker`, 1 = table-mate, 2 = speaker, … */
export function pickExchangeB99(speaker: string, seed: number): Exchange {
  const keyed = KEYED_EXCHANGES[speaker as OfficeCharacterName];
  if (keyed && seed % 4 === 0) return keyed;
  return pick(EXCHANGES, seed);
}

// ─── the bundle handed to the theme ──────────────────────────────────────────

export const B99_FLOOR_FLAVOR = {
  errandThoughts: B99_ERRAND_THOUGHTS,
  gossipLines: B99_GOSSIP_LINES,
  suckUpLines: B99_SUCK_UP_LINES,
  cheerLines: B99_CHEER_LINES,
  pickSoloLine: pickSoloLineB99,
  pickExchange: pickExchangeB99,
};
