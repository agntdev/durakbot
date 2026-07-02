import { describe, it, expect, beforeEach } from "vitest";
import {
  joinGame,
  startGame,
  attackPhase,
  passAttack,
  defendPhase,
  takeCards,
  resolveRound,
  leaveGame,
  createGame,
  ActiveGameError,
  PlayerInGameError,
  GameCreationError,
} from "../src/game/engine.js";
import {
  resetGameStoreClient,
  saveGame,
  savePlayer,
  getPlayer,
  setChatGameIndex,
} from "../src/game/store.js";
import type { Game, Player } from "../src/game/types.js";

function makeGame(overrides: Partial<Game> = {}): Game {
  return {
    game_code: "ABCD",
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
    created_at: 1000000,
    version: 0,
    ...overrides,
  };
}

function makePlayer(overrides: Partial<Player> = {}): Player {
  return {
    telegram_id: 100,
    game_code: "ABCD",
    seat_index: 0,
    hand: [],
    status: "playing",
    joined_at: 1000000,
    ...overrides,
  };
}

describe("game engine — full game flow", () => {
  beforeEach(() => {
    resetGameStoreClient();
  });

  it("rejects invalid join codes", async () => {
    const result = await joinGame(200, "XXXX");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Game not found — check the code and try again.");
  });

  it("rejects joining a started game", async () => {
    await saveGame(makeGame({ status: "playing" }));
    const r = await joinGame(200, "ABCD");
    expect(r.ok).toBe(false);
    expect(r.error).toBe("This game has already started.");
  });

  it("rejects joining a full lobby", async () => {
    await saveGame(makeGame({ player_count: 6 }));
    for (let i = 1; i <= 6; i++) {
      await savePlayer(makePlayer({ telegram_id: i, seat_index: i - 1 }));
    }
    const r = await joinGame(7, "ABCD");
    expect(r.ok).toBe(false);
    expect(r.error).toBe("Lobby is full (max 6 players).");
  });

  it("rejects starting with only 1 player", async () => {
    await saveGame(makeGame());
    await savePlayer(makePlayer());
    const r = await startGame("ABCD", 100);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("Need at least 2 players to start.");
  });

  it("attack requires valid rank on table (invalid rank rejected)", async () => {
    await saveGame(makeGame({
      status: "playing",
      trump_suit: "clubs",
      current_attacker_index: 0,
      current_defender_index: 1,
      attacker_ids: [0],
    }));

    await savePlayer(makePlayer({
      telegram_id: 100,
      seat_index: 0,
      hand: [
        { rank: "7", suit: "spades" },
        { rank: "9", suit: "hearts" },
      ],
    }));

    await savePlayer(makePlayer({
      telegram_id: 200,
      seat_index: 1,
      hand: [
        { rank: "8", suit: "spades" },
        { rank: "10", suit: "hearts" },
      ],
    }));

    // First attack → valid
    const atk1 = await attackPhase(100, "ABCD", { rank: "7", suit: "spades" });
    expect(atk1.ok).toBe(true);
    expect(atk1.game!.table_cards).toHaveLength(1);

    // Second attack with invalid rank (only 7 is on table)
    const atk2 = await attackPhase(100, "ABCD", { rank: "9", suit: "hearts" });
    expect(atk2.ok).toBe(false);
    expect(atk2.error).toContain("That rank isn't on the table");
  });

  it("defender can take cards", async () => {
    await saveGame(makeGame({
      status: "playing",
      trump_suit: "hearts",
      current_attacker_index: 0,
      current_defender_index: 1,
      attacker_ids: [0],
      table_cards: [
        { attack: { rank: "7", suit: "spades" }, defense: null },
      ],
    }));

    await savePlayer(makePlayer({
      telegram_id: 100, seat_index: 0, hand: [],
    }));

    await savePlayer(makePlayer({
      telegram_id: 200,
      seat_index: 1,
      hand: [
        { rank: "9", suit: "hearts" },
        { rank: "10", suit: "diamonds" },
      ],
    }));

    const take = await takeCards(200, "ABCD");
    expect(take.ok).toBe(true);
    expect(take.game!.table_cards).toHaveLength(0);
    expect(take.game!.round_over).toBe(true);

    const updatedP2 = take.players!.find(p => p.telegram_id === 200);
    expect(updatedP2!.hand).toHaveLength(3);
    expect(updatedP2!.hand.some(c => c.rank === "7" && c.suit === "spades")).toBe(true);
  });

  it("defend phase: beating an attack", async () => {
    await saveGame(makeGame({
      status: "playing",
      trump_suit: "hearts",
      current_attacker_index: 0,
      current_defender_index: 1,
      attacker_ids: [0],
      passed_ids: [0], // attacker has passed
      table_cards: [
        { attack: { rank: "6", suit: "spades" }, defense: null },
      ],
    }));

    await savePlayer(makePlayer({
      telegram_id: 100, seat_index: 0, hand: [],
    }));

    await savePlayer(makePlayer({
      telegram_id: 200,
      seat_index: 1,
      hand: [{ rank: "A", suit: "spades" }],
    }));

    const def = await defendPhase(200, "ABCD", 0, { rank: "A", suit: "spades" });
    expect(def.ok).toBe(true);
    expect(def.game!.table_cards[0].defense).toEqual({ rank: "A", suit: "spades" });
    expect(def.game!.round_over).toBe(true);
    expect(def.players!.find(p => p.telegram_id === 200)!.hand).toHaveLength(0);
  });

  it("endgame detection: finishers get 'finished' status", async () => {
    await saveGame(makeGame({
      status: "playing",
      trump_suit: "hearts",
      current_attacker_index: 0,
      current_defender_index: 1,
      attacker_ids: [0],
      passed_ids: [0],
      table_cards: [],
      round_over: true,
      deck: [],
      discard: [],
    }));

    // 2 players empty, 1 has cards
    await savePlayer(makePlayer({ telegram_id: 100, seat_index: 0, hand: [], status: "playing" }));
    await savePlayer(makePlayer({ telegram_id: 200, seat_index: 1, hand: [], status: "playing" }));
    await savePlayer(makePlayer({ telegram_id: 300, seat_index: 2, hand: [{ rank: "7", suit: "spades" }], status: "playing" }));

    const result = await resolveRound("ABCD");
    expect(result.ok).toBe(true);

    // Players with empty hands should be marked finished
    const allPlayers = result.players!;
    expect(allPlayers.find(p => p.telegram_id === 100)!.status).toBe("finished");
    expect(allPlayers.find(p => p.telegram_id === 200)!.status).toBe("finished");

    // Not finished yet (2 players still playing... wait, 2 are finished, 1 remains active)
    // remainingPlayers.length = 1, so game IS finished
    expect(result.finished).toBe(true);
    expect(result.standings).toBeDefined();

    const durak = result.standings!.find(s => s.label === "🤡 Durak");
    expect(durak).toBeDefined();
    expect(durak!.seat_index).toBe(2);
  });

  it("seat rotation after defense", async () => {
    await saveGame(makeGame({
      status: "playing",
      trump_suit: "hearts",
      current_attacker_index: 0,
      current_defender_index: 1,
      attacker_ids: [0],
      table_cards: [
        { attack: { rank: "6", suit: "spades" }, defense: { rank: "8", suit: "spades" } },
      ],
      round_over: true,
      deck: [
        { rank: "A", suit: "clubs" },
        { rank: "K", suit: "clubs" },
        { rank: "Q", suit: "clubs" },
      ],
    }));

    await savePlayer(makePlayer({ telegram_id: 100, seat_index: 0, hand: [{ rank: "6", suit: "spades" }], status: "playing" }));
    await savePlayer(makePlayer({ telegram_id: 200, seat_index: 1, hand: [{ rank: "7", suit: "spades" }], status: "playing" }));
    await savePlayer(makePlayer({ telegram_id: 300, seat_index: 2, hand: [{ rank: "8", suit: "spades" }], status: "playing" }));

    const result = await resolveRound("ABCD");
    expect(result.ok).toBe(true);
    expect(result.finished).toBe(false);
    expect(result.game!.current_attacker_index).toBe(1);
    expect(result.game!.current_defender_index).toBe(2);
  });

  it("player leaving during play ends game if only 1 remains", async () => {
    await saveGame(makeGame({ status: "playing" }));
    await savePlayer(makePlayer({ telegram_id: 100, seat_index: 0, hand: [{ rank: "7", suit: "spades" }], status: "playing" }));
    await savePlayer(makePlayer({ telegram_id: 200, seat_index: 1, hand: [{ rank: "8", suit: "hearts" }], status: "playing" }));

    const result = await leaveGame(100);
    expect(result.ok).toBe(true);
    expect(result.message).toContain("not enough players");
  });

  it("createGame succeeds and creates audit event", async () => {
    const result = await createGame(1, 100);
    expect(result.game).toBeDefined();
    expect(result.game.status).toBe("lobby");
    expect(result.game.player_count).toBe(1);
    expect(result.game.chat_id).toBe(1);
    expect(result.correlationId).toBeDefined();

    // Player should be saved
    const player = await getPlayer(100);
    expect(player).not.toBeNull();
    expect(player!.game_code).toBe(result.game.game_code);
  });

  it("createGame blocks duplicates in same group chat", async () => {
    // Create first game in group chat
    const first = await createGame(1, 100, true);
    expect(first.game).toBeDefined();

    // Second game from different user in same group chat should fail
    await expect(createGame(1, 200, true)).rejects.toThrow(ActiveGameError);
  });

  it("createGame detects when player already in a game", async () => {
    // Create first game in private chat (no group conflict check)
    const first = await createGame(1, 100, false);
    expect(first.game).toBeDefined();

    // Same user tries to create another game (different chat) — should fail
    await expect(createGame(2, 100, false)).rejects.toThrow(PlayerInGameError);
  });

  it("concurrent game creation in same group chat: only first succeeds", async () => {
    // Create a game first to set the active-game index
    const first = await createGame(500, 101, true);
    expect(first.game).toBeDefined();
    expect(first.correlationId).toBeDefined();
    expect(first.correlationId.length).toBeGreaterThan(0);

    // Subsequent attempts in the same group chat should all fail
    const attempts = [
      createGame(500, 102, true),
      createGame(500, 103, true),
    ];

    await expect(attempts[0]).rejects.toThrow(ActiveGameError);
    await expect(attempts[1]).rejects.toThrow(ActiveGameError);
  });

  it("concurrent game creation in different chats allows multiple games", async () => {
    // Two users in different private chats should both succeed
    const promises = [
      createGame(600, 201, false),
      createGame(601, 202, false),
    ];

    const results = await Promise.allSettled(promises);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(2);
  });
});