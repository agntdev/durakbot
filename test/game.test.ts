import { describe, it, expect, beforeEach } from "vitest";
import { createDeck, shuffleDeck, trumpSuitFromDeck, pickFirstAttacker, canBeat, isValidAttackRank, isPlayableAttack, drawFromDeck, computeStandings } from "../src/game/deck.js";
import { resetGameStoreClient, saveGame, getGame, savePlayer, getPlayer, getGamePlayers, getGamePlayerCount, getPlayerGameCode } from "../src/game/store.js";
import type { Card, Game, Player } from "../src/game/types.js";

describe("deck", () => {
  it("creates a 36-card deck", () => {
    const deck = createDeck();
    expect(deck.length).toBe(36);
    expect(deck[0]).toEqual({ rank: "6", suit: "spades" });
    expect(deck[35]).toEqual({ rank: "A", suit: "clubs" });
  });

  it("shuffles deterministically", () => {
    const deck = createDeck();
    const shuffled1 = shuffleDeck(deck, 42);
    const shuffled2 = shuffleDeck(deck, 42);
    expect(shuffled1).toEqual(shuffled2);
    expect(shuffled1).not.toEqual(deck);
  });

  it("trump suit is from the bottom card", () => {
    const deck = createDeck();
    const shuffled = shuffleDeck(deck, 123);
    const trump = trumpSuitFromDeck(shuffled);
    expect(trump).toBe(shuffled[shuffled.length - 1].suit);
  });

  it("canBeat: same suit, higher rank wins", () => {
    const attack: Card = { rank: "7", suit: "spades" };
    const defend: Card = { rank: "8", suit: "spades" };
    expect(canBeat(attack, defend, "clubs")).toBe(true);
  });

  it("canBeat: same suit, lower rank loses", () => {
    const attack: Card = { rank: "8", suit: "spades" };
    const defend: Card = { rank: "7", suit: "spades" };
    expect(canBeat(attack, defend, "clubs")).toBe(false);
  });

  it("canBeat: trump beats non-trump", () => {
    const attack: Card = { rank: "A", suit: "spades" };
    const defend: Card = { rank: "6", suit: "clubs" };
    expect(canBeat(attack, defend, "clubs")).toBe(true);
  });

  it("canBeat: non-trump does not beat trump attack", () => {
    const attack: Card = { rank: "6", suit: "clubs" };
    const defend: Card = { rank: "A", suit: "spades" };
    expect(canBeat(attack, defend, "clubs")).toBe(false);
  });

  it("isPlayableAttack: first attack is always valid", () => {
    const card: Card = { rank: "7", suit: "spades" };
    expect(isPlayableAttack(card, [])).toBe(true);
  });

  it("isPlayableAttack: rank must be on table", () => {
    const card: Card = { rank: "9", suit: "hearts" };
    const table = [
      { attack: { rank: "7", suit: "spades" }, defense: null },
      { attack: { rank: "8", suit: "clubs" }, defense: null },
    ];
    expect(isPlayableAttack(card, table)).toBe(false);
  });

  it("isPlayableAttack: matching rank is valid", () => {
    const card: Card = { rank: "8", suit: "hearts" };
    const table = [
      { attack: { rank: "7", suit: "spades" }, defense: null },
      { attack: { rank: "8", suit: "clubs" }, defense: null },
    ];
    expect(isPlayableAttack(card, table)).toBe(true);
  });

  it("drawFromDeck fills hand to 6 cards", () => {
    const hand: Card[] = [{ rank: "7", suit: "spades" }];
    const deck = createDeck();
    const result = drawFromDeck(hand, deck, []);
    expect(result.hand.length).toBe(6);
    expect(result.deck.length).toBe(36 - 5);
  });

  it("drawFromDeck reshuffles discard when deck empty", () => {
    const hand: Card[] = [{ rank: "7", suit: "spades" }];
    const deck: Card[] = [];
    const discard: Card[] = [
      { rank: "8", suit: "hearts" }, { rank: "9", suit: "clubs" },
      { rank: "10", suit: "diamonds" }, { rank: "J", suit: "spades" },
      { rank: "Q", suit: "hearts" }, { rank: "K", suit: "clubs" },
    ];
    const result = drawFromDeck(hand, deck, discard);
    expect(result.hand.length).toBe(6);
  });

  it("pickFirstAttacker picks lowest trump holder", () => {
    const players = [
      { hand: [{ rank: "A", suit: "hearts" }] },
      { hand: [{ rank: "6", suit: "hearts" }] },
    ];
    expect(pickFirstAttacker(players, "hearts")).toBe(1);
  });

  it("pickFirstAttacker returns a valid seat when nobody has trump", () => {
    const players = [
      { hand: [{ rank: "A", suit: "spades" }] },
      { hand: [{ rank: "K", suit: "clubs" }] },
    ];
    const idx = pickFirstAttacker(players, "hearts");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(idx).toBeLessThan(players.length);
  });

  it("computeStandings: first to empty hand wins, last is Durak", () => {
    const players = [
      { telegram_id: 1, hand: [], seat_index: 0 },
      { telegram_id: 2, hand: [{ rank: "7", suit: "spades" }], seat_index: 1 },
      { telegram_id: 3, hand: [{ rank: "7", suit: "clubs" }, { rank: "8", suit: "hearts" }], seat_index: 2 },
    ];
    const standings = computeStandings(players);
    expect(standings[0].label).toBe("🎉 Winner");
    expect(standings[0].seat_index).toBe(0);
    expect(standings[2].label).toBe("🤡 Durak");
    expect(standings[2].seat_index).toBe(2);
  });
});

describe("game store", () => {
  beforeEach(() => {
    resetGameStoreClient();
  });

  it("saves and loads a game", async () => {
    const game: Game = {
      game_code: "TEST",
      chat_id: 1,
      status: "lobby",
      trump_suit: "spades",
      trump_card: { rank: "A", suit: "spades" },
      deck: [],
      discard: [],
      table_cards: [],
      current_attacker_index: 0,
      current_defender_index: 0,
      player_count: 0,
      attacker_ids: [],
      passed_ids: [],
      round_over: false,
      created_at: 0,
      version: 0,
    };
    await saveGame(game);
    const loaded = await getGame("TEST");
    expect(loaded).not.toBeNull();
    expect(loaded!.game_code).toBe("TEST");
    expect(loaded!.trump_suit).toBe("spades");
  });

  it("saves and loads a player", async () => {
    const player: Player = {
      telegram_id: 123,
      game_code: "TEST",
      seat_index: 0,
      hand: [{ rank: "7", suit: "spades" }],
      status: "playing",
      joined_at: 0,
    };
    await savePlayer(player);
    const loaded = await getPlayer(123);
    expect(loaded).not.toBeNull();
    expect(loaded!.game_code).toBe("TEST");
    expect(loaded!.hand).toEqual([{ rank: "7", suit: "spades" }]);
  });

  it("tracks game players via set", async () => {
    await savePlayer({ telegram_id: 1, game_code: "G1", seat_index: 0, hand: [], status: "playing", joined_at: 0 });
    await savePlayer({ telegram_id: 2, game_code: "G1", seat_index: 1, hand: [], status: "playing", joined_at: 0 });

    const players = await getGamePlayers("G1");
    expect(players).toHaveLength(2);
    expect(await getGamePlayerCount("G1")).toBe(2);
  });

  it("player game code lookup works", async () => {
    await savePlayer({ telegram_id: 5, game_code: "ABCD", seat_index: 0, hand: [], status: "playing", joined_at: 0 });
    const code = await getPlayerGameCode(5);
    expect(code).toBe("ABCD");
  });
});
