/**
 * Game orchestration logic — creates games, processes turns, handles phase
 * transitions, and interfaces between the persistent store and the card engine.
 */
import type { Game, Player, Card, TableCard, Suit, AuditEvent } from "./types.js";
import {
  createDeck,
  shuffleDeck,
  trumpSuitFromDeck,
  pickFirstAttacker,
  canBeat,
  isPlayableAttack,
  drawFromDeck,
  computeStandings,
} from "./deck.js";
import {
  saveGame,
  saveGameWithVersion,
  getGame,
  savePlayer,
  getPlayer,
  getPlayerGameCode,
  getGamePlayers,
  getGamePlayerCount,
  removePlayer,
  removeAllPlayers,
  saveAction,
  deleteGame,
  saveAuditEvent,
  setChatGameIndex,
  clearChatGameIndex,
  chatHasActiveGame,
  getChatGameCode,
  ConcurrentModificationError,
} from "./store.js";
import { now } from "./clock.js";
import { cardKey } from "./types.js";

/** Generate a 4-character alphanumeric game code. */
export function generateGameCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 4; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function cryptoSeed(): number {
  try {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    return buf[0];
  } catch {
    return (now() * 16807) % 2147483647;
  }
}

/**
 * Generate a v4-style UUID for correlation tracking.
 */
export function generateCorrelationId(): string {
  const hex = "0123456789abcdef";
  let id = "";
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      id += "-";
    } else if (i === 14) {
      id += "4";
    } else if (i === 19) {
      id += hex[(Math.floor(Math.random() * 4) + 8)];
    } else {
      id += hex[Math.floor(Math.random() * 16)];
    }
  }
  return id;
}

/** Helper: run a DB operation with one retry + short exponential backoff. */
async function withRetry<T>(fn: () => Promise<T>, context: string): Promise<T> {
  const maxAttempts = 2;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      // Only retry on transient-like errors
      const msg = String(err);
      const isTransient =
        msg.includes("timeout") ||
        msg.includes("ETIMEDOUT") ||
        msg.includes("ECONNRESET") ||
        msg.includes("ECONNREFUSED") ||
        msg.includes("network") ||
        msg.includes("429") ||
        msg.includes("500") ||
        msg.includes("503");
      if (!isTransient) throw err;
      // Exponential backoff: ~200ms then ~400ms
      await new Promise(r => setTimeout(r, 200 * attempt));
    }
  }
  throw new Error(`retry exhausted for ${context}`);
}

/** Create a new lobby game with idempotent, transactional creation and audit logging. */
export async function createGame(
  chatId: number,
  hostId: number,
  isGroupChat = false,
): Promise<{ game: Game; correlationId: string }> {
  const correlationId = generateCorrelationId();
  const payload: Record<string, unknown> = { chatId, hostId };
  let result: "success" | "failure" = "failure";
  let errorMessage: string | null = null;
  let stackTrace: string | null = null;

  try {
    // Check for active game in this chat (group chats only — private DMs manage
    // many simultaneous games by game code)
    if (isGroupChat) {
      const existing = await withRetry(() => chatHasActiveGame(chatId), "createGame:activeCheck");
      if (existing) {
        const existingCode = await getChatGameCode(chatId);
        errorMessage = `A game (${existingCode}) is already active in this chat.`;
        result = "failure";
        await saveAuditEvent({
          correlation_id: correlationId,
          event_type: "game_create_attempt",
          user_id: hostId,
          chat_id: chatId,
          payload,
          result,
          error_message: errorMessage,
          stack_trace: null,
        });
        throw new ActiveGameError(errorMessage, correlationId);
      }
    }

    // Check if player is already in a game
    const playerGameCode = await getPlayerGameCode(hostId);
    if (playerGameCode) {
      const existingGame = await getGame(playerGameCode);
      if (existingGame && existingGame.status !== "finished") {
        errorMessage = "You're already in a game. Leave it first.";
        result = "failure";
        await saveAuditEvent({
          correlation_id: correlationId,
          event_type: "game_create_attempt",
          user_id: hostId,
          chat_id: chatId,
          payload,
          result,
          error_message: errorMessage,
          stack_trace: null,
        });
        throw new PlayerInGameError(errorMessage, existingGame.game_code, correlationId);
      }
    }

    // Generate unique code
    let code = "";
    for (let attempt = 0; attempt < 100; attempt++) {
      code = generateGameCode();
      const existing = await getGame(code);
      if (!existing) break;
      if (attempt === 99) {
        errorMessage = "Could not generate a unique game code";
        result = "failure";
        await saveAuditEvent({
          correlation_id: correlationId,
          event_type: "game_create_attempt",
          user_id: hostId,
          chat_id: chatId,
          payload,
          result,
          error_message: errorMessage,
          stack_trace: null,
        });
        throw new Error(errorMessage);
      }
    }

    const seed = cryptoSeed();
    const deck = shuffleDeck(createDeck(), seed);
    const trump_suit = trumpSuitFromDeck(deck);
    const trump_card = deck[deck.length - 1];

    const game: Game = {
      game_code: code,
      chat_id: chatId,
      status: "lobby",
      trump_suit,
      trump_card,
      deck,
      discard: [],
      table_cards: [],
      current_attacker_index: 0,
      current_defender_index: 0,
      player_count: 1,
      attacker_ids: [],
      passed_ids: [],
      round_over: false,
      created_at: now(),
      version: 0,
    };

    // Transactional: save game + chat index first
    await withRetry(() => saveGameWithVersion(game), "createGame:saveGame");
    await withRetry(() => setChatGameIndex(chatId, code), "createGame:chatIndex");

    // Then save player
    const player: Player = {
      telegram_id: hostId,
      game_code: code,
      seat_index: 0,
      hand: [],
      status: "playing",
      joined_at: now(),
    };
    await withRetry(() => savePlayer(player), "createGame:savePlayer");

    result = "success";
    await saveAuditEvent({
      correlation_id: correlationId,
      event_type: "game_create_attempt",
      user_id: hostId,
      chat_id: chatId,
      payload: { ...payload, game_code: code },
      result,
      error_message: null,
      stack_trace: null,
    });

    return { game, correlationId };
  } catch (err) {
    // If it's one of our known error types, re-throw as-is
    if (err instanceof ActiveGameError || err instanceof PlayerInGameError) throw err;

    errorMessage = String(err);
    stackTrace = err instanceof Error ? (err.stack ?? null) : null;
    result = "failure";

    // Audit the failure
    try {
      await saveAuditEvent({
        correlation_id: correlationId,
        event_type: "game_create_attempt",
        user_id: hostId,
        chat_id: chatId,
        payload,
        result,
        error_message: errorMessage,
        stack_trace: stackTrace,
      });
    } catch {
      // Best-effort audit logging
    }

    throw err instanceof ActiveGameError || err instanceof PlayerInGameError
      ? err
      : new GameCreationError(errorMessage, correlationId);
  }
}

/** Error: chat already has an active game. */
export class ActiveGameError extends Error {
  correlationId: string;
  constructor(message: string, correlationId: string) {
    super(message);
    this.name = "ActiveGameError";
    this.correlationId = correlationId;
  }
}

/** Error: player is in an existing game. */
export class PlayerInGameError extends Error {
  gameCode: string;
  correlationId: string;
  constructor(message: string, gameCode: string, correlationId: string) {
    super(message);
    this.name = "PlayerInGameError";
    this.gameCode = gameCode;
    this.correlationId = correlationId;
  }
}

/** Error: transient game-creation failure with correlation tracking. */
export class GameCreationError extends Error {
  correlationId: string;
  constructor(message: string, correlationId: string) {
    super(message);
    this.name = "GameCreationError";
    this.correlationId = correlationId;
  }
}

/** Join an existing lobby by game code. */
export async function joinGame(
  telegramId: number,
  code: string,
): Promise<{ ok: boolean; error?: string; game?: Game; player?: Player }> {
  const game = await getGame(code.toUpperCase());
  if (!game) return { ok: false, error: "Game not found — check the code and try again." };
  if (game.status !== "lobby") return { ok: false, error: "This game has already started." };

  const existingPlayer = await getPlayer(telegramId);
  if (existingPlayer && existingPlayer.game_code === game.game_code) {
    return { ok: true, error: "You're already in this game.", game, player: existingPlayer };
  }
  if (existingPlayer && existingPlayer.game_code !== game.game_code) {
    return { ok: false, error: "You're already in another game. Leave it first with /leave." };
  }

  const count = await getGamePlayerCount(game.game_code);
  if (count >= 6) return { ok: false, error: "Lobby is full (max 6 players)." };

  const player: Player = {
    telegram_id: telegramId,
    game_code: game.game_code,
    seat_index: count,
    hand: [],
    status: "playing",
    joined_at: now(),
  };
  // Save player FIRST so a failed player save leaves the count unchanged.
  // If the game save fails after, remove the player to keep state consistent.
  await savePlayer(player);
  game.player_count = count + 1;
  {
    const err = await saveGameAtomic(game);
    if (err) {
      // Roll back: remove the orphan player
      try {
        await removePlayer(player.telegram_id, player.game_code);
      } catch {
        // Best-effort rollback
      }
      return { ok: false, error: err, game, player };
    }
  }
  await saveAction({ player_id: telegramId, game_code: game.game_code, action_type: "join", timestamp: now() });

  return { ok: true, game, player };
}

/** Start the game: deal cards, determine first attacker, set status to playing. */
export async function startGame(
  code: string,
  telegramId: number,
): Promise<{ ok: boolean; error?: string; game?: Game; players?: Player[] }> {
  const game = await getGame(code);
  if (!game) return { ok: false, error: "Game not found." };
  if (game.status !== "lobby") return { ok: false, error: "Game has already started." };

  const players = await getGamePlayers(code);
  if (players.length < 2) return { ok: false, error: "Need at least 2 players to start." };
  if (players.length > 6) return { ok: false, error: "Too many players (max 6)." };

  if (players[0].telegram_id !== telegramId) {
    return { ok: false, error: "Only the host can start the game." };
  }

  // Deal 6 cards to each player
  let deck = [...game.deck];
  for (const player of players) {
    const hand: Card[] = [];
    for (let i = 0; i < 6; i++) {
      if (deck.length > 0) hand.push(deck.pop()!);
    }
    player.hand = hand;
    await savePlayer(player);
  }

  const firstAttackerIdx = pickFirstAttacker(players, game.trump_suit, game.version);

  game.status = "playing";
  game.deck = deck;
  game.current_attacker_index = firstAttackerIdx;
  game.current_defender_index = (firstAttackerIdx + 1) % players.length;
  game.attacker_ids = [firstAttackerIdx];
  game.passed_ids = [];
  game.table_cards = [];
  game.round_over = false;
  {
    const err = await saveGameAtomic(game);
    if (err) return { ok: false, error: err };
  }
  await saveAction({ player_id: telegramId, game_code: code, action_type: "start", timestamp: now() });

  return { ok: true, game, players };
}

/**
 * Record a player's attack card. The attacker must be at the current attacker
 * seat or one of the other attacker seats.
 */
export async function attackPhase(
  telegramId: number,
  code: string,
  attackCard: Card,
): Promise<{ ok: boolean; error?: string; game?: Game; players?: Player[] }> {
  const game = await getGame(code);
  if (!game) return { ok: false, error: "Game not found." };
  if (game.status !== "playing") return { ok: false, error: "Game is not in progress." };

  const players = await getGamePlayers(code);
  const player = players.find(p => p.telegram_id === telegramId);
  if (!player) return { ok: false, error: "You're not in this game." };
  if (player.status !== "playing") return { ok: false, error: "You've already finished this game." };

  // Check if this player is allowed to attack
  const isMainAttacker = player.seat_index === game.current_attacker_index;
  const isOtherAttacker = game.attacker_ids.includes(player.seat_index);
  if (!isMainAttacker && !isOtherAttacker) {
    return { ok: false, error: "It's not your turn to attack." };
  }
  if (game.passed_ids.includes(player.seat_index)) {
    return { ok: false, error: "You already passed this round." };
  }
  if (game.round_over) {
    return { ok: false, error: "The round is over — wait for the defender to resolve." };
  }

  // Validate the card is in the player's hand
  const cardIdx = player.hand.findIndex(c => c.rank === attackCard.rank && c.suit === attackCard.suit);
  if (cardIdx < 0) return { ok: false, error: "That card isn't in your hand." };

  // Validate attack rules
  const defender = players.find(p => p.seat_index === game.current_defender_index);
  const defenderHandSize = defender ? defender.hand.length : 0;
  const maxAttacks = Math.min(6, defenderHandSize);
  if (game.table_cards.length >= maxAttacks) {
    return { ok: false, error: "Can't add more attacks — defender has no cards left to defend with." };
  }

  if (!isPlayableAttack(attackCard, game.table_cards)) {
    return { ok: false, error: "That rank isn't on the table. Attack with a card matching a rank already in play, or start a new round." };
  }

  // Remove card from hand, add to table
  player.hand.splice(cardIdx, 1);
  game.table_cards.push({ attack: attackCard, defense: null });

  // Add player to attacker_ids if not already
  if (!game.attacker_ids.includes(player.seat_index)) {
    game.attacker_ids.push(player.seat_index);
  }

  await savePlayer(player);
  {
    const err = await saveGameAtomic(game);
    if (err) return { ok: false, error: err };
  }
  await saveAction({ player_id: telegramId, game_code: code, action_type: `attack:${cardKey(attackCard)}`, timestamp: now() });

  return { ok: true, game, players };
}

/**
 * Player passes (declines to add more attacks). Only valid for non-main-attacker
 * seats, or for the main attacker after at least one attack has been made.
 */
export async function passAttack(
  telegramId: number,
  code: string,
): Promise<{ ok: boolean; error?: string; game?: Game; players?: Player[] }> {
  const game = await getGame(code);
  if (!game) return { ok: false, error: "Game not found." };
  if (game.status !== "playing") return { ok: false, error: "Game is not in progress." };

  const players = await getGamePlayers(code);
  const player = players.find(p => p.telegram_id === telegramId);
  if (!player) return { ok: false, error: "You're not in this game." };
  if (!game.attacker_ids.includes(player.seat_index)) return { ok: false, error: "You're not an attacker this round." };
  if (game.passed_ids.includes(player.seat_index)) return { ok: false, error: "You already passed this round." };
  if (game.round_over) return { ok: false, error: "The round is already over." };

  game.passed_ids.push(player.seat_index);
  {
    const err = await saveGameAtomic(game);
    if (err) return { ok: false, error: err };
  }
  await saveAction({ player_id: telegramId, game_code: code, action_type: "pass", timestamp: now() });

  // Check if all attackers have passed
  const allPassed = game.attacker_ids.every(ai => game.passed_ids.includes(ai));
  if (allPassed && game.table_cards.length > 0) {
    game.round_over = true;
    {
      const err = await saveGameAtomic(game);
      if (err) return { ok: false, error: err };
    }
  }

  return { ok: true, game, players };
}

/**
 * Defender plays a defense card against a specific attack on the table.
 */
export async function defendPhase(
  telegramId: number,
  code: string,
  tableIdx: number,
  defendCard: Card,
): Promise<{ ok: boolean; error?: string; game?: Game; players?: Player[] }> {
  const game = await getGame(code);
  if (!game) return { ok: false, error: "Game not found." };
  if (game.status !== "playing") return { ok: false, error: "Game is not in progress." };

  const players = await getGamePlayers(code);
  const defender = players.find(p => p.telegram_id === telegramId && p.seat_index === game.current_defender_index);
  if (!defender) return { ok: false, error: "You're not the defender." };
  if (game.round_over) return { ok: false, error: "The round is already over — resolve it first." };

  if (tableIdx < 0 || tableIdx >= game.table_cards.length) {
    return { ok: false, error: "No attack to defend at that position." };
  }
  const tableEntry = game.table_cards[tableIdx];
  if (tableEntry.defense) return { ok: false, error: "That attack is already defended." };

  // Validate card in hand
  const cardIdx = defender.hand.findIndex(c => c.rank === defendCard.rank && c.suit === defendCard.suit);
  if (cardIdx < 0) return { ok: false, error: "That card isn't in your hand." };

  // Validate defense
  if (!canBeat(tableEntry.attack, defendCard, game.trump_suit)) {
    return { ok: false, error: "That card can't beat the attack. Use a higher card of the same suit or a trump." };
  }

  // Remove card, mark defense
  defender.hand.splice(cardIdx, 1);
  game.table_cards[tableIdx] = { attack: tableEntry.attack, defense: defendCard };
  await savePlayer(defender);
  {
    const err = await saveGameAtomic(game);
    if (err) return { ok: false, error: err };
  }
  await saveAction({ player_id: telegramId, game_code: code, action_type: `defend:${cardKey(defendCard)}`, timestamp: now() });

  // Check if all attacks are defended and table is full or no new attacks coming
  const allDefended = game.table_cards.every(tc => tc.defense !== null);
  const allAttackersPassed = game.attacker_ids.every(ai => game.passed_ids.includes(ai));
  if (allDefended && (allAttackersPassed || game.table_cards.length >= 6)) {
    game.round_over = true;
    {
      const err = await saveGameAtomic(game);
      if (err) return { ok: false, error: err };
    }
  }

  return { ok: true, game, players };
}

/**
 * Defender takes all table cards into their hand.
 */
export async function takeCards(
  telegramId: number,
  code: string,
): Promise<{ ok: boolean; error?: string; game?: Game; players?: Player[] }> {
  const game = await getGame(code);
  if (!game) return { ok: false, error: "Game not found." };
  if (game.status !== "playing") return { ok: false, error: "Game is not in progress." };

  const players = await getGamePlayers(code);
  const defender = players.find(p => p.telegram_id === telegramId && p.seat_index === game.current_defender_index);
  if (!defender) return { ok: false, error: "You're not the defender." };

  if (game.table_cards.length === 0) {
    return { ok: false, error: "No cards on the table to take." };
  }

  // Add all table cards to defender's hand
  for (const tc of game.table_cards) {
    defender.hand.push(tc.attack);
    if (tc.defense) defender.hand.push(tc.defense);
  }

  game.table_cards = [];
  game.round_over = true;
  await savePlayer(defender);
  {
    const err = await saveGameAtomic(game);
    if (err) return { ok: false, error: err };
  }
  await saveAction({ player_id: telegramId, game_code: code, action_type: "take", timestamp: now() });

  return { ok: true, game, players };
}

/**
 * Resolve the end of a round: move cards to discard, draw new cards,
 * rotate attacker/defender, detect endgame.
 */
export async function resolveRound(
  code: string,
  telegramId?: number,
): Promise<{
  ok: boolean;
  error?: string;
  game?: Game;
  players?: Player[];
  finished?: boolean;
  standings?: { telegram_id: number; seat_index: number; place: number; label: string }[];
}> {
  const game = await getGame(code);
  if (!game) return { ok: false, error: "Game not found." };

  const players = await getGamePlayers(code);

  // Authorization: only the defender may resolve the round
  if (telegramId !== undefined) {
    const caller = players.find(p => p.telegram_id === telegramId);
    if (!caller) return { ok: false, error: "You're not in this game." };
    if (game.status === "playing" && !game.round_over) {
      return { ok: false, error: "The round isn't over yet." };
    }
    if (game.status === "playing" && caller.seat_index !== game.current_defender_index) {
      return { ok: false, error: "Only the defender can resolve the round." };
    }
  }

  // Move table cards to discard
  for (const tc of game.table_cards) {
    game.discard.push(tc.attack);
    if (tc.defense) game.discard.push(tc.defense);
  }
  game.table_cards = [];
  game.round_over = false;
  game.passed_ids = [];

  // Draw cards: first attacker fills, then others in turn order
  const n = players.length;
  const order: number[] = [];
  for (let i = 0; i < n; i++) {
    order.push((game.current_attacker_index + i) % n);
  }

  for (const seatIdx of order) {
    const p = players.find(pp => pp.seat_index === seatIdx);
    if (!p || p.status !== "playing") continue;
    const result = drawFromDeck(p.hand, game.deck, game.discard);
    p.hand = result.hand;
    game.deck = result.deck;
    game.discard = result.discard;
    await savePlayer(p);
  }

  // Check for players who finished (empty hands)
  const playingPlayers = players.filter(p => p.status === "playing");
  for (const p of playingPlayers) {
    if (p.hand.length === 0) {
      p.status = "finished";
      await savePlayer(p);
    }
  }

  const remainingPlayers = players.filter(p => p.status === "playing");
  let finished = false;
  let standings: { telegram_id: number; seat_index: number; place: number; label: string }[] | undefined;

  if (remainingPlayers.length <= 1) {
    // Game over
    finished = true;
    game.status = "finished";
    // Mark last player as finished too
    for (const p of remainingPlayers) {
      p.status = "finished";
      await savePlayer(p);
    }
    // Clear chat index so a new game can be created
    await clearChatGameIndex(game.chat_id);
    standings = computeStandings(
      players.map(p => ({
        telegram_id: p.telegram_id,
        hand: p.hand,
        seat_index: p.seat_index,
      })),
    );
  } else {
    // Rotate: next player clockwise becomes attacker
    let nextAttackerIdx = (game.current_attacker_index + 1) % n;
    while (
      !players.find(p => p.seat_index === nextAttackerIdx && p.status === "playing")
    ) {
      nextAttackerIdx = (nextAttackerIdx + 1) % n;
    }
    game.current_attacker_index = nextAttackerIdx;

    let nextDefenderIdx = (nextAttackerIdx + 1) % n;
    while (
      !players.find(p => p.seat_index === nextDefenderIdx && p.status === "playing")
    ) {
      nextDefenderIdx = (nextDefenderIdx + 1) % n;
    }
    game.current_defender_index = nextDefenderIdx;
    game.attacker_ids = [game.current_attacker_index];
  }

  {
    const err = await saveGameAtomic(game);
    if (err) return { ok: false, error: err, game, players, finished, standings };
  }
  return { ok: true, game, players, finished, standings };
}

/**
 * Helper: save game with optimistic concurrency. Returns an error string on
 * version conflict, or null on success.
 */
async function saveGameAtomic(game: Game): Promise<string | null> {
  try {
    await saveGameWithVersion(game);
    return null;
  } catch (err) {
    if (err instanceof ConcurrentModificationError) {
      return "The game state changed before your action could be processed. Please try again.";
    }
    throw err;
  }
}
export async function leaveGame(
  telegramId: number,
): Promise<{ ok: boolean; error?: string; game?: Game; message?: string }> {
  const player = await getPlayer(telegramId);
  if (!player) return { ok: false, error: "You're not in any game." };

  const game = await getGame(player.game_code);
  if (!game) return { ok: false, error: "Game not found." };

  if (game.status === "lobby") {
    await removePlayer(telegramId, player.game_code);
    const remaining = await getGamePlayers(player.game_code);
    const count = remaining.length;
    game.player_count = count;
    {
      const err = await saveGameAtomic(game);
      if (err) return { ok: false, error: err };
    }

    if (count === 0) {
      await deleteGame(player.game_code); // also clears chat index
      return { ok: true, message: "You left. The lobby was cancelled — no players left." };
    }

    // Reassign seat indices
    for (let i = 0; i < remaining.length; i++) {
      remaining[i].seat_index = i;
      await savePlayer(remaining[i]);
    }
    return { ok: true, message: `You left. ${count} player${count === 1 ? "" : "s"} remaining.` };
  }

  if (game.status === "playing") {
    player.status = "left";
    game.discard.push(...player.hand);
    player.hand = [];
    await savePlayer(player);

    const allPlayers = await getGamePlayers(player.game_code);
    const n = allPlayers.length;
    const activePlayers = allPlayers.filter(p => p.status === "playing");

    // If the leaving player was the current attacker or defender, reassign to next active player
    if (activePlayers.length > 0) {
      if (player.seat_index === game.current_attacker_index) {
        let nextIdx = (game.current_attacker_index + 1) % n;
        // Keep stepping until we find an active player
        for (let tries = 0; tries < n; tries++) {
          if (allPlayers.find(p => p.seat_index === nextIdx && p.status === "playing")) {
            game.current_attacker_index = nextIdx;
            game.attacker_ids = [nextIdx];
            game.passed_ids = [];
            break;
          }
          nextIdx = (nextIdx + 1) % n;
        }
      }
      if (player.seat_index === game.current_defender_index) {
        let nextIdx = (game.current_defender_index + 1) % n;
        for (let tries = 0; tries < n; tries++) {
          if (allPlayers.find(p => p.seat_index === nextIdx && p.status === "playing")) {
            game.current_defender_index = nextIdx;
            break;
          }
          nextIdx = (nextIdx + 1) % n;
        }
      }
    }

    {
      const err = await saveGameAtomic(game);
      if (err) return { ok: false, error: err };
    }

    if (activePlayers.length <= 1) {
      game.status = "finished";
      {
        const err = await saveGameAtomic(game);
        if (err) return { ok: false, error: err };
      }
      // Clear chat index so a new game can be created
      await clearChatGameIndex(game.chat_id);
      if (activePlayers.length === 1) {
        activePlayers[0].status = "finished";
        await savePlayer(activePlayers[0]);
      }
      return {
        ok: true,
        message: "You left. The game is over — not enough players.",
      };
    }

    return { ok: true, message: "You left. Your cards were placed in the discard pile." };
  }

  return { ok: false, error: "That game has already finished." };
}
