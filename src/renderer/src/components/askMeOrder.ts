/**
 * Ordering for the ASK ME board.
 *
 * The board had NO comparator at all: `tasks.filter(waitsOnHuman)` rendered in
 * whatever order the cards happened to sit in a 440KB tasks.json, which is
 * roughly card-creation order across the whole file and has nothing to do with
 * when a question was asked. A question from five minutes ago could land below
 * one from three days ago, and the order shifted as unrelated cards were added.
 *
 * This module is the ordering rule ONLY, kept free of every import (no React,
 * no store) so the comparator is unit-testable on its own — the same reason
 * queueDelivery.ts keeps its gate structural.
 *
 * IMPORTANT — there are two orderings on this screen and only the OUTER one is
 * sorted here: the list of CARDS (this file). The `humanQA` array WITHIN a card
 * is a conversation history, rendered oldest-first through the "VIEW N EARLIER
 * ANSWERS" collapse, and must stay chronological. Never reverse it.
 */

/** The only thing the ordering needs from a card's open ask. Structural so the
 *  test does not have to construct a whole HiveTask. */
export interface AskLike {
  askedAt?: string;
}

/** `askedAt` as epoch ms, or null when it is missing or unparseable.
 *  Never throws — a hand-edited ledger must not be able to crash the board. */
export function askedAtMs(open: AskLike | undefined): number | null {
  const raw = open?.askedAt;
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Newest ask first, oldest last.
 *
 * Callers pass each card's OPEN question (from `openQuestion()`), so "open"
 * is derived from the same predicate `waitsOnHuman` already uses rather than
 * being defined a second time here.
 *
 * Cards whose open ask carries no parseable `askedAt` sort LAST, so a bad
 * timestamp costs that one card its position instead of throwing.
 */
export function compareByNewestAsk(a: AskLike | undefined, b: AskLike | undefined): number {
  const ax = askedAtMs(a);
  const bx = askedAtMs(b);
  if (ax === null && bx === null) return 0;
  if (ax === null) return 1;  // a has no time -> after b
  if (bx === null) return -1; // b has no time -> after a
  return bx - ax;             // descending
}
