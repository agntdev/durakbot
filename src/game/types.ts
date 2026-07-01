/**
 * Core types for the Durak card game engine.
 */

export type Suit = "spades" | "hearts" | "diamonds" | "clubs";
export type Rank = "6" | "7" | "8" | "9" | "10" | "J" | "Q" | "K" | "A";

export const SUITS: Suit[] = ["spades", "hearts", "diamonds", "clubs"];
export const RANKS: Rank[] = ["6", "7", "8", "9", "10", "J", "Q", "K", "A"];

/** Ranks ordered by strength (6 weakest, A strongest). */
export const RANK_ORDER: Record<Rank, number> = {
  "6": 0, "7": 1, "8": 2, "9": 3, "10": 4, "J": 5, "Q": 6, "K": 7, "A": 8,
};

export interface Card {
  rank: Rank;
  suit: Suit;
}

export interface TableCard {
  attack: Card;
  defense: Card | null;
}

export type GameStatus = "lobby" | "playing" | "finished";

export interface Game {
  game_code: string;
  chat_id: number;
  status: GameStatus;
  trump_suit: Suit;
  trump_card: Card;
  deck: Card[];
  discard: Card[];
  table_cards: TableCard[];
  current_attacker_index: number;
  current_defender_index: number;
  player_count: number;
  /** Seat indices of players who can still attack this round. */
  attacker_ids: number[];
  /** Seat indices of players who have passed this round. */
  passed_ids: number[];
  /** When true, the round is over and draw phase begins. */
  round_over: boolean;
  created_at: number;
}

export type PlayerStatus = "playing" | "finished" | "left";

export interface Player {
  telegram_id: number;
  game_code: string;
  seat_index: number;
  hand: Card[];
  status: PlayerStatus;
  joined_at: number;
}

export interface Action {
  player_id: number;
  game_code: string;
  action_type: string;
  timestamp: number;
}

/** Emoji for each suit. */
export const SUIT_EMOJI: Record<Suit, string> = {
  spades: "♠️",
  hearts: "♥️",
  diamonds: "♦️",
  clubs: "♣️",
};

/** Display a card for user-facing text: "♠️A", "♥️10", etc. */
export function cardDisplay(card: Card): string {
  return `${SUIT_EMOJI[card.suit]}${card.rank}`;
}

/** Encode a card as a compact string for callback data (≤64 bytes). */
export function cardKey(card: Card): string {
  const s = card.suit[0].toUpperCase(); // S, H, D, C
  return `${card.rank}${s}`;
}

/** Decode a card key back to a Card. Returns null on invalid. */
export function decodeCardKey(key: string): Card | null {
  if (key.length < 2) return null;
  const suitMap: Record<string, Suit> = { S: "spades", H: "hearts", D: "diamonds", C: "clubs" };
  const rankPart = key.slice(0, -1);
  const suitPart = key.slice(-1).toUpperCase();
  if (!RANKS.includes(rankPart as Rank)) return null;
  if (!suitMap[suitPart]) return null;
  return { rank: rankPart as Rank, suit: suitMap[suitPart] };
}
