// Original precinct break-room chatter. Lines are short, work-oriented, and
// written for this app rather than quoted or adapted from television dialogue.

import type { CharacterName } from './cast';

export type BreakSpot = 'coffee' | 'vending' | 'snack' | 'table';

const pick = <T,>(arr: readonly T[], seed: number): T =>
  arr[((seed % arr.length) + arr.length) % arr.length];

const SPOT_POOL: Record<BreakSpot, readonly string[]> = {
  coffee: [
    'fresh pot, clean slate',
    'briefing fuel secured',
    'the night shift left us some',
    'one cup, then back to the case',
  ],
  vending: [
    'the machine kept my coin',
    'choosing evidence snacks',
    'this button feels suspicious',
    'stakeout supplies acquired',
  ],
  snack: [
    'label your leftovers, detectives',
    'quick bite between leads',
    'these crackers are now evidence',
    'saving one for the late shift',
  ],
  table: [
    'five-minute case reset',
    'compare notes after the briefing?',
    'the board has a new lead',
    'quiet room, loud whiteboard',
  ],
};

const BY_CHARACTER: Record<CharacterName, readonly string[]> = {
  holt: ['facts first, then conclusions', 'the briefing begins on time', 'clarity is a public service'],
  terry: ['check the plan, then the people', 'no one tackles a blocker alone', 'steady work closes cases'],
  jake: ['I have a theory and two backups', 'follow the weird clue', 'that bug has an alibi'],
  amy: ['the checklist has a checklist', 'document the chain of evidence', 'tests first, victory second'],
  rosa: ['show me the failing case', 'small patch, sharp proof', 'skip the speech; run the test'],
  charles: ['I traced every side path', 'tiny details solve big cases', 'I brought organized notes'],
  gina: ['the workflow is confessing', 'I found the human bottleneck', 'high signal, zero clutter'],
  hitchcock: ['I remember this old failure mode', 'check the forgotten branch', 'the regression left fingerprints'],
  scully: ['I ran it twice to be sure', 'recovery drill passed', 'routine checks save the shift'],
};

export function pickSoloLine(character: CharacterName, spot: BreakSpot, seed: number): string {
  return seed % 5 < 3
    ? pick(BY_CHARACTER[character], Math.floor(seed / 5))
    : pick(SPOT_POOL[spot], seed);
}

type Exchange = readonly string[];

const EXCHANGES: readonly Exchange[] = [
  ['new lead on the board.', 'verified?', 'running the check now.'],
  ['the build is green.', 'under real conditions?', 'good question.'],
  ['I found the blocker.', 'root cause or symptom?', 'root cause, with notes.'],
  ['need a second set of eyes?', 'always.', 'send the case file.'],
  ['quiet shift today.', 'you just tempted fate.', 'noted.'],
  ['the logs tell a story.', 'short version?', 'someone skipped validation.'],
  ['coffee or evidence first?', 'evidence.', 'correct answer.'],
  ['I simplified the plan.', 'what changed?', 'fewer handoffs.'],
  ['can we close this one?', 'after the regression test.', 'already running.'],
  ['the clue was in plain sight.', 'where?', 'the default config.'],
  ['I wrote down the assumption.', 'then challenged it?', 'that was the fun part.'],
  ['handoff is ready.', 'context included?', 'and the next step.'],
];

const KEYED_EXCHANGES: Partial<Record<CharacterName, Exchange>> = {
  holt: ['status report.', 'green, with one monitored risk.', 'concise. acceptable.'],
  terry: ['who needs backup?', 'the integration check.', 'I am on it.'],
  jake: ['unusual theory.', 'how unusual?', 'three tests away from brilliant.'],
  amy: ['I indexed the findings.', 'by severity?', 'and confidence.'],
  rosa: ['patch is ready.', 'how small?', 'smaller than this conversation.'],
  charles: ['I found an edge case.', 'of course you did.', 'I found four.'],
  gina: ['the process needs one change.', 'which one?', 'the obvious one nobody sees.'],
  hitchcock: ['seen this before.', 'same cause?', 'same smell. checking now.'],
  scully: ['verification complete.', 'all environments?', 'all available environments.'],
};

export function pickExchange(speaker: CharacterName, seed: number): Exchange {
  const keyed = KEYED_EXCHANGES[speaker];
  return keyed && seed % 4 === 0 ? keyed : pick(EXCHANGES, seed);
}
