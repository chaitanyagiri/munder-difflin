// Cafeteria small-talk — The Office edition.
//
// The cast ARE Dunder Mifflin (see cast.ts), so an agent's coffee break is an
// excuse for a one-liner in character. Two kinds of line:
//   • solo  — one quip shown above a single agent at a break spot
//   • pair  — a two-beat exchange between two agents at the same table
//
// Lines are kept short so they fit the ThoughtBubble (≈MAX_WIDTH). Character
// keys match OfficeCharacterName; anyone without bespoke lines falls back to the
// shared GENERIC pool so the floor never feels empty.

import type { CharacterName } from './cast';

/** Where an agent is lingering — picks a contextual line pool. */
export type BreakSpot = 'coffee' | 'vending' | 'snack' | 'table';

const pick = <T,>(arr: readonly T[], seed: number): T =>
  arr[((seed % arr.length) + arr.length) % arr.length];

// ─── solo lines, by spot ─────────────────────────────────────────────────────

const COFFEE: readonly string[] = [
  'is this… decaf?? who did this',
  "we're out of beans again",
  'World’s Best Boss mug',
  'first cup of the day. and the fifth.',
  'the coffee here is basically a hug',
  'who took my mug?',
];

const VENDING: readonly string[] = [
  'the machine ate my dollar',
  'B4… please be the pretzels',
  'it’s stuck. classic.',
  'shaking it. gently. respectfully.',
  'one (1) emotional-support snack',
  'A1 again. living dangerously.',
];

const SNACK: readonly string[] = [
  'is it Pretzel Day?',
  'who finished the chips??',
  'just a little treat',
  'these are everyone’s? cool cool cool',
  'second breakfast',
];

const TABLE: readonly string[] = [
  'big day. lots of meetings.',
  'just five more minutes',
  'did you see the standup notes?',
  'pretending to read my notes',
  'I needed this break, honestly',
  'do NOT tell the Professor I’m in here',
];

const SPOT_POOL: Record<BreakSpot, readonly string[]> = {
  coffee: COFFEE, vending: VENDING, snack: SNACK, table: TABLE,
};

// ─── character flavour — overrides the generic pool when present ─────────────

const BY_CHARACTER: Partial<Record<CharacterName, readonly string[]>> = {
  michael:  ['I DECLARE… BANKRUPTCY!', "that's what she said", "I'm not superstitious. just a little stitious.", 'no meetings before coffee. that’s the rule.'],
  dwight:   ['FALSE.', 'identity theft is not a joke', 'that mug is regulation', 'this fridge needs a beet drawer', 'Schrute Farms has better coffee'],
  jim:      ["...that's what she said", 'bears. beets. Battlestar Galactica.', 'I moved Dwight’s stapler again', 'just here for the gossip'],
  pam:      ['Dunder Mifflin, this is Pam', 'sketching the vending machine', 'the watercolor of the break room'],
  kevin:    ['the chili is NOT ready', 'why waste time say lot word', 'me want snack', 'cookie? cookie.'],
  angela:   ['this break room is filthy', 'party planning committee, 3pm', 'I’m judging the fridge'],
  oscar:    ['actually, it’s “espresso”', 'well, actually…', 'the budget for snacks is concerning'],
  stanley:  ['is it Pretzel Day?', 'did I stutter?', 'crossword and coffee. leave me be.', "I'll retire before this brews"],
  phyllis:  ['Bob is picking me up at five', 'knitting and a nice cup of tea'],
  andy:     ['Cornell, ever heard of it?', 'rit-dit-dit, coffee break!', 'Big Tuna, grab a chair'],
  kelly:    ['did you HEAR what happened??', 'so. much. to tell you.', 'I am the GOSSIP queen'],
  ryan:     ['I’m kind of a big deal', 'the temp needs caffeine', 'starting a coffee startup, actually'],
  toby:     ['I should write that up…', 'HR-wise this break is fine', 'no one ever sits with me'],
  creed:    ['which one of you is the new guy?', 'I’ve eaten worse out of that fridge', 'mung beans. under my desk.'],
  meredith: ['is it 5 o’clock yet?', 'someone spike the coffee?'],
};

/** A solo break-room line. Character flavour ~60% of the time, else the line
 *  fits the spot the agent is standing at. `seed` keeps it deterministic per
 *  call site (avoids Math.random, which Pixi/Electron CSP-safe code prefers). */
export function pickSoloLine(character: CharacterName, spot: BreakSpot, seed: number): string {
  const flavour = BY_CHARACTER[character];
  if (flavour && seed % 5 < 3) return pick(flavour, Math.floor(seed / 5));
  return pick(SPOT_POOL[spot], seed);
}

// ─── paired exchanges (two agents at one table) ──────────────────────────────
//
// Each exchange is a list of beats that ALTERNATE between the two agents:
// beat[0] = the speaker who sat down, beat[1] = their table-mate, beat[2] =
// speaker again, and so on. The director plays them out one beat at a time.
// Lines are trimmed to fit the thought cloud; longer ones auto-truncate.

type Exchange = readonly string[];

// Generic banter — works between any two agents (they're all Dunder Mifflin).
const EXCHANGES: readonly Exchange[] = [
  ['world’s best boss.', 'you are. I had the mug made.', 'and I cherish it.'],
  ['would an idiot do this?', '...if yes, I don’t.', 'that’s my boy.'],
  ['feared or loved? both.', 'that’s beautiful.', 'I know.'],
  ['I edited your wiki page again.', 'I know. thank you.'],
  ['question. how many bears?', 'one.', 'that’s too many.'],
  ['fact: bears eat beets.', 'bears. beets. Galactica.', 'what is happening.'],
  ['I grew up on a beet farm.', 'shocking.', '...not shocking at all.'],
  ['what’s Schrute Farms smell like?', 'victory. and beets.'],
  ['did you just throw your phone?', 'didn’t like what it said.', 'cool.'],
  ['is a hot dog a sandwich?', 'it is.', 'I know, right?'],
  ['three-hole-punch Jim returns.', 'never gets old.'],
  ['why few word when lot word?', '...genuinely profound.', 'I know.'],
  ['I am not a bad person.', '...', 'not a great person either.', 'there it is.'],
  ['I love my cats more than people.', 'including us?', 'especially you.'],
  ['cats are better than dogs.', 'dogs are better.', '...sorry.'],
  ['do you love me?', 'I love… being here.', 'that’s a yes.'],
  ['I’m kind of a big deal.', 'you are?', 'in my mind. yes.'],
  ['did you miss me?', 'no.', 'a little?', '...there it is.'],
  ['did you just roll your eyes?', 'I did.', 'why?', 'muscle memory.'],
  ['I’ve watched that clock since 4.', 'weren’t you working?', 'watching the clock.'],
  ['what do we sell again?', 'paper.', 'sure, yeah.'],
  ['how old are you?', 'yeah.', 'that’s not an answer.', 'sure it is.'],
  ['that’s not how math works.', 'I know.', 'then why?', 'faster.'],
  ['I’m not an alcoholic.', 'you went to a meeting.', 'for the food.'],
  ['I went to Cornell.', 'nobody cares.', 'I went to Cornell.', 'still nobody cares.'],
  ['I have a lot of feelings.', 'I can tell.', 'is that bad?', 'for us? yes.'],
  ['why are you the way you are?', '...', 'honestly.'],
  ['your cat died.', 'I know.', 'I’m sorry.', '...thank you.'],
  ['stop looking at me.', 'you stop looking at me.'],
  ['sign this.', 'what is it?', 'doesn’t matter.', '...fine.'],
  ['you can’t say that.', 'I just did.', 'gonna stop me?', '...no.'],
  ['that’s a fire lane.', 'fire hasn’t happened yet.'],
  ['I wrapped your stapler in Jello.', 'I’ll eat around it.', 'fair.'],
  ['zombie attack plan?', 'especially that.', 'of course.'],
  ['just seeing if you’d answer.', 'I hate you.', 'I know.'],
  ['a little stitious, not super.', 'that’s not a word.', 'it is now.'],
  ['funniest person in the office?', 'and other times?', 'other times I know it.'],
  ['that’s what she said.', '...every time.', 'come on.'],
  ['I started the fire.', 'no you didn’t.', 'in our hearts, I did.'],
  ['is today a day ending in Y?', 'yes.', 'then no.'],
  ['Bob Vance.', 'Phyllis Vance.', 'Vance Refrigeration.'],
  ['you look beautiful today.', '...I know.'],
  ['I’m better than you in every way.', 'probably.', 'definitely.', 'sure.'],
  ['I’m a nice guy.', 'you’re okay.', 'nicest thing you’ve said.'],
  ['are you okay?', 'I’ve been worse.', 'when?', 'can’t narrow it down.'],
  ['there’s a spider on your desk.', 'where?', '...you ate it.', 'protein.'],
  ['soul mates can be bosses.', 'you’re my boss.', 'exactly.'],
  ['standup ran 40 minutes.', 'could’ve been an email.'],
  ['is the build green yet?', '...don’t look.'],
  ['who reply-all’d everyone?', 'we don’t talk about it.'],
];

// ─── "that's what she said" ──────────────────────────────────────────────────
//
// The office's favourite bit. These are generic (added to the shared pool
// below) so ANY two agents at a table can run them: whoever sits down first
// delivers the innocent setup (beat 0) and their table-mate lands the punchline
// (beat 1). Some carry the show's follow-up beats — a sheepish clarification and
// the inevitable "still counts." Setups are trimmed to fit the thought cloud.
const TWSS_EXCHANGES: readonly Exchange[] = [
  ['taking way longer than I expected.', 'that’s what she said.'],
  ['it’s too big, can’t fit it in my mouth.', 'that’s what she said.'],
  ['you really need to slow down.', 'that’s what she said.'],
  ['gonna need a bigger one.', 'that’s what she said.'],
  ['help, I can’t get it to go in.', 'that’s what she said.'],
  ['it’s not that hard if you just push.', 'that’s what she said.'],
  ['I can’t do this all night.', 'that’s what she said.'],
  ['I need it now, I can’t wait.', 'that’s what she said.'],
  ['so hot in here, I’m sweating.', 'that’s what she said.'],
  ['it keeps slipping out of my hands.', 'that’s what she said.'],
  ['why not just stick it in already?', 'that’s what she said.', '*looks at camera*'],
  ['I just need a few more inches.', 'that’s what she said.', 'for the shelf!', 'still counts.'],
  ['make it louder, I can barely feel it.', 'that’s what she said.'],
  ['can we get this over with quickly?', 'that’s what she said.', 'I meant the meeting.', 'sure.'],
  ['I just need you to hold it steady.', 'that’s what she said.'],
  ['can’t believe I did that all morning.', 'that’s what she said.'],
  ['my hands are cramping.', 'that’s what she said.', 'from typing!', 'that’s what she said.'],
  ['hours in and barely halfway done.', 'that’s what she said.'],
  ['surprisingly heavy for its size.', 'that’s what she said.'],
  ['be more precise. less sloppy.', 'that’s what she said.', 'I meant the spreadsheet.', 'I know.'],
  ['how long was it?', 'that’s what she said.', '*the whole room goes quiet*', 'I’m sorry, I can’t help it.'],
  ['too tight, cutting off my circulation.', 'that’s what she said.', '*mouths thank you*'],
  ['I don’t think it’ll fit.', 'that’s what she said.', '*stands up and applauds*'],
  ['stop, you’re doing it wrong.', 'that’s what she said.', 'never been prouder.'],
  ['this just keeps getting harder.', 'that’s what she said.', 'he’s ready.'],
  ['not wide enough, I need more room.', 'that’s what she said.'],
  ['I can hold it a really long time.', 'that’s what she said.', 'my breath!', 'still.'],
  ['why is it taking so long?', 'that’s what she said.', 'I hate you.', 'then why set me up?'],
  ['I can’t do it with people watching.', 'that’s what she said.', 'the presentation!', 'sure.'],
  ['it’s deeper than it looks.', 'that’s what she said.', 'the pothole, the Professor!', 'doesn’t matter.'],
  ['so much longer than last time.', 'that’s what she said.', 'the report, the Professor.', 'right, right.'],
  ['oh my god, it went on FOREVER.', 'that’s what she said.', 'the Twilight movie!', 'classic.'],
  ['can’t believe how thick this is.', 'that’s what she said.', 'the folder. *stares*'],
  ['I fit all THAT in one day?', 'that’s what she said.', 'that’s actually what I said!', 'meta.'],
  ['I went at it hard this morning.', 'that’s what she said.', 'at the gym!', 'irrelevant.'],
  ['someone help me finish this off.', 'that’s what she said.', 'the leftover cake!', 'still works.'],
  ['get in, do my thing, get out.', 'that’s what she said.', '*doesn’t look up from crossword*'],
  ['can’t believe it took this long.', 'that’s what she said.', 'the raise. eight years.', 'that one’s on me.'],
  ['do it slower, it’ll hurt less.', 'that’s what she said.', 'for the quarterly review.', 'sure, Oscar.'],
  ['didn’t realize how big it’d be.', 'that’s what she said.', 'the calzone, it’s enormous!', 'I love this office.'],
  ['*to no one* that’s what she said.', 'nobody said anything.', 'just thinking about earlier.'],
  ['*on the phone* that’s what she said.', 'who was that?', 'my mother. about a sandwich.'],
  ['too hot in here! that’s what she said.', 'you said both parts.', 'I contain multitudes.'],
  ['*at the TV* that’s what she said.', 'you’re alone, the Professor.', 'she doesn’t know that.'],
  ['you need to be more professional.', 'that’s what she said.', 'I am she.', '...that’s what she said.'],
  ['stop. just stop. every time—', 'that’s what she said.', '*leaves the room*', '*whispers* that’s what she said.'],
  ['as you can see, it’s going up.', 'that’s what she said.', '*everyone groans*', 'set that one up myself.'],
  ['I declared bankruptcy once. felt good.', 'what does that have to do with—', 'that’s what she said.', 'it doesn’t.', 'I know.'],
  ['you didn’t say it.', 'I know.', 'why not?', 'I’m growing.', '...that’s what she said.', 'there it is.'],
  ['impressive you held back today.', 'thank you.', 'I counted zero times.', 'that’s what she said.', 'still counts.'],
];

// Everything any table-mate pair can draw from.
const PAIR_POOL: readonly Exchange[] = [...EXCHANGES, ...TWSS_EXCHANGES];

// Keyed off the SPEAKER so, when the right character sits down first, they get
// to open with their signature bit.
const KEYED_EXCHANGES: Partial<Record<CharacterName, Exchange>> = {
  michael:  ['that’s what she said.', '...there it is.'],
  dwight:   ['identity theft is not a joke.', 'nobody touched your stapler, Dwight.'],
  kevin:    ['why few word when lot word?', '...just use the words, Kevin.'],
  kelly:    ['okay don’t freak out, but—', 'I’m already freaking out.'],
  oscar:    ['well, actually—', '...here we go.'],
  angela:   ['this table is filthy.', 'it’s a break room, Angela.'],
  creed:    ['which one are you again?', '...we sit next to each other.'],
  stanley:  ['is it Pretzel Day?', 'no, Stanley.', '...did I stutter?'],
  andy:     ['I went to Cornell.', 'nobody cares.', '...I went to Cornell.'],
  jim:      ['question.', 'yes.', 'nothing. just checking.'],
};

/** A multi-beat exchange for two agents sharing a table. Beats alternate:
 *  index 0 = `speaker`, 1 = the table-mate, 2 = speaker, … */
export function pickExchange(speaker: CharacterName, seed: number): Exchange {
  const keyed = KEYED_EXCHANGES[speaker];
  if (keyed && seed % 4 === 0) return keyed;
  return pick(PAIR_POOL, seed);
}
