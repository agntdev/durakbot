/**
 * 36-card deck, deterministic shuffle for fairness.
 */
import type { Card, Rank, Suit } from "./types.js";
import { RANKS, SUITS } from "./types.js";
import { now } from "./clock.js";

/** Create a fresh 36-card deck (ranks 6–A, 4 suits). */
export function createDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ rank, suit });
    }
  }
  return deck;
}

/**
 * Deterministic shuffle using a simple seed-based algorithm.
 * In production, the seed comes from a crypto source.
 */
export function shuffleDeck(deck: Card[], seed: number): Card[] {
  const cards = [...deck];
  // Fisher-Yates with seeded PRNG
  let s = seed;
  for (let i = cards.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    const j = (s >>> 0) % (i + 1);
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}

/**
 * Determine the trump suit from the bottom card (last card in the deck).
 */
export function trumpSuitFromDeck(deck: Card[]): Suit {
  // The bottom card is the "trump card" — it is shown face-up
  // under the deck and its suit is trump.
  return deck[deck.length - 1].suit;
}

/**
 * Pick the first attacker: lowest trump rank, or random if no trumps.
 */
export function pickFirstAttacker(players: { hand: Card[] }[], trump: Suit): number {
  let bestIdx = -1;
  let bestRank = -1;
  for (let i = 0; i < players.length; i++) {
    const trumps = players[i].hand.filter(c => c.suit === trump);
    if (trumps.length > 0) {
      const minRankIdx = trumps.reduce((min, c) => {
        const idx = RANKS.indexOf(c.rank);
        return idx < min ? idx : min;
      }, 9);
      if (bestIdx === -1 || minRankIdx < bestRank) {
        bestIdx = i;
        bestRank = minRankIdx;
      }
    }
  }
  return bestIdx >= 0 ? bestIdx : Math.floor(Math.random() * players.length);
}

/** Check if a card can beat an attack card given the trump suit. */
export function canBeat(attack: Card, defend: Card, trump: Suit): boolean {
  if (attack.suit === defend.suit) {
    // Same suit: higher rank wins
    return RANKS.indexOf(defend.rank) > RANKS.indexOf(attack.rank);
  }
  // Different suits: defender wins only if they play a trump against non-trump
  return defend.suit === trump && attack.suit !== trump;
}

/** Check if an attack rank is valid (matches a rank already on the table). */
export function isValidAttackRank(tableCards: { attack: Card; defense: Card | null }[], rank: Rank): boolean {
  if (tableCards.length === 0) return true; // first attack is always valid
  for (const tc of tableCards) {
    if (tc.attack.rank === rank) return true;
    if (tc.defense && tc.defense.rank === rank) return true;
  }
  return false;
}

/**
 * Check if a card can be used as an attack given what's on the table.
 * The card's rank must already be on the table (attack or defense card).
 */
export function isPlayableAttack(
  card: Card,
  tableCards: { attack: Card; defense: Card | null }[],
): boolean {
  if (tableCards.length === 0) return true;
  return isValidAttackRank(tableCards, card.rank);
}

/** Draw cards from the deck to fill a hand to 6 cards. Returns drawn cards. */
export function drawFromDeck(
  hand: Card[],
  deck: Card[],
  discard: Card[],
): { hand: Card[]; deck: Card[]; discard: Card[] } {
  const remainingDeck = [...deck];
  const remainingDiscard = [...discard];
  const newHand = [...hand];
  while (newHand.length < 6 && remainingDeck.length > 0) {
    newHand.push(remainingDeck.pop()!);
  }
  // If deck runs out, reshuffle discard (Fisher-Yates) and use as new deck
  while (newHand.length < 6 && remainingDiscard.length > 0) {
    // Seed from the testable clock for reproducibility in tests
    remainingDeck.push(...shuffleDeck(remainingDiscard, (now() * 16807) % 2147483647));
    remainingDiscard.length = 0;
    while (newHand.length < 6 && remainingDeck.length > 0) {
      newHand.push(remainingDeck.pop()!);
    }
  }
  return { hand: newHand, deck: remainingDeck, discard: remainingDiscard };
}

/** Calculate final standings: first to empty hand = winner, last = Durak. */
export function computeStandings(
  players: { telegram_id: number; hand: Card[]; seat_index: number }[],
): { telegram_id: number; seat_index: number; place: number; label: string }[] {
  const sorted = [...players].sort((a, b) => a.hand.length - b.hand.length);
  return sorted.map((p, i) => {
    const place = i + 1;
    const label = i === 0 ? "🎉 Winner" : i === sorted.length - 1 ? "🤡 Durak" : `${place}${ordinal(place)} place`;
    return { telegram_id: p.telegram_id, seat_index: p.seat_index, place, label };
  });
}

function ordinal(n: number): string {
  const s = n % 10;
  const h = n % 100;
  if (s === 1 && h !== 11) return "st";
  if (s === 2 && h !== 12) return "nd";
  if (s === 3 && h !== 13) return "rd";
  return "th";
}
