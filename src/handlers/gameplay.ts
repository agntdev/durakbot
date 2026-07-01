import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import {
  inlineButton,
  inlineKeyboard,
  registerMainMenuItem,
} from "../toolkit/index.js";
import {
  getPlayer,
  getGame,
  getGamePlayers,
} from "../game/store.js";
import {
  cardDisplay,
  cardKey,
  decodeCardKey,
  SUIT_EMOJI,
} from "../game/types.js";
import type { Card } from "../game/types.js";

// Register "Leave Game" in the main menu
registerMainMenuItem({ label: "🚪 Leave game", data: "game:leave", order: 60 });

const composer = new Composer<Ctx>();

// --- Attack ---
composer.callbackQuery(/^game:attack:(.+):(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const code = ctx.match![1];
  const cardKeyStr = ctx.match![2];
  const card = decodeCardKey(cardKeyStr);

  if (!card) {
    await ctx.answerCallbackQuery({ text: "Invalid card selection.", show_alert: true });
    return;
  }

  const { attackPhase } = await import("../game/engine.js");

  const result = await attackPhase(ctx.from!.id, code, card);

  if (!result.ok) {
    await ctx.answerCallbackQuery({ text: result.error ?? "Couldn't play that card.", show_alert: true });
    return;
  }

  const game = result.game!;
  const players = result.players!;

  // Update the hand message if possible
  await showPlayerHand(ctx, ctx.from!.id, game, players);

  // Notify group
  try {
    const attacker = players.find(p => p.telegram_id === ctx.from!.id);
    const attackerIdx = attacker?.seat_index ?? -1;
    await ctx.api.sendMessage(
      game.chat_id,
      `⚔️ Player ${attackerIdx + 1} attacked with ${cardDisplay(card)}`,
      {
        reply_markup: inlineKeyboard([
          [inlineButton("📋 View table", "menu:table")],
        ]),
      },
    );
  } catch {
    // Best-effort
  }

  // Notify defender
  try {
    const defender = players.find(p => p.seat_index === game.current_defender_index);
    if (defender) {
      await ctx.api.sendMessage(
        defender.telegram_id,
        `🛡️ You're being attacked! A player played ${cardDisplay(card)}. Check /hand to defend.`,
      );
    }
  } catch {
    // Best-effort DM
  }
});

// --- Pass attack ---
composer.callbackQuery(/^game:pass:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const code = ctx.match![1];
  const { passAttack } = await import("../game/engine.js");

  const result = await passAttack(ctx.from!.id, code);

  if (!result.ok) {
    await ctx.answerCallbackQuery({ text: result.error ?? "Couldn't pass.", show_alert: true });
    return;
  }

  const game = result.game!;
  const players = result.players!;

  await ctx.answerCallbackQuery({ text: "Passed." });

  // Notify group
  try {
    const player = players.find(p => p.telegram_id === ctx.from!.id);
    await ctx.api.sendMessage(
      game.chat_id,
      `☑️ Player ${(player?.seat_index ?? -1) + 1} passed.`,
    );
  } catch {
    // Best-effort
  }

  // If round is over, notify defender
  if (game.round_over) {
    try {
      const defender = players.find(p => p.seat_index === game.current_defender_index);
      if (defender) {
        await ctx.api.sendMessage(
          defender.telegram_id,
          "🛡️ It's your turn to defend! Reply with /hand to see your options.",
        );
      }
    } catch {
      // Best-effort
    }
  }
});

// --- Defend ---
composer.callbackQuery(/^game:defend:(.+):(\d+):(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const code = ctx.match![1];
  const tableIdx = parseInt(ctx.match![2], 10);
  const cardKeyStr = ctx.match![3];
  const card = decodeCardKey(cardKeyStr);

  if (!card) {
    await ctx.answerCallbackQuery({ text: "Invalid card selection.", show_alert: true });
    return;
  }

  const { defendPhase } = await import("../game/engine.js");

  const result = await defendPhase(ctx.from!.id, code, tableIdx, card);

  if (!result.ok) {
    await ctx.answerCallbackQuery({ text: result.error ?? "Couldn't defend.", show_alert: true });
    return;
  }

  const game = result.game!;
  const players = result.players!;

  // Update hand view
  await showPlayerHand(ctx, ctx.from!.id, game, players);

  // Notify group
  try {
    const defender = players.find(p => p.telegram_id === ctx.from!.id);
    await ctx.api.sendMessage(
      game.chat_id,
      `🛡️ Player ${(defender?.seat_index ?? -1) + 1} defended with ${cardDisplay(card)}`,
      {
        reply_markup: inlineKeyboard([
          [inlineButton("📋 View table", "menu:table")],
        ]),
      },
    );
  } catch {
    // Best-effort
  }

  // If round is now over, notify defender to resolve
  if (game.round_over) {
    try {
      const defender = players.find(p => p.seat_index === game.current_defender_index);
      if (defender) {
        await ctx.api.sendMessage(
          defender.telegram_id,
          "All attacks defended! Tap Next round to continue, or check /hand.",
          {
            reply_markup: inlineKeyboard([
              [inlineButton("▶️ Next round", `game:resolve:${code}`)],
            ]),
          },
        );
      }
    } catch {
      // Best-effort
    }
  }
});

// --- Take cards ---
composer.callbackQuery(/^game:take:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const code = ctx.match![1];
  const { takeCards } = await import("../game/engine.js");

  const result = await takeCards(ctx.from!.id, code);

  if (!result.ok) {
    await ctx.answerCallbackQuery({ text: result.error ?? "Couldn't take cards.", show_alert: true });
    return;
  }

  const game = result.game!;
  const players = result.players!;

  // Notify group
  try {
    const defender = players.find(p => p.telegram_id === ctx.from!.id);
    await ctx.api.sendMessage(
      game.chat_id,
      `🤲 Player ${(defender?.seat_index ?? -1) + 1} took all table cards.`,
      {
        reply_markup: inlineKeyboard([
          [inlineButton("📋 View table", "menu:table")],
        ]),
      },
    );
  } catch {
    // Best-effort
  }

  // Notify defender to resolve
  try {
    await ctx.api.sendMessage(
      ctx.from!.id,
      "You took the cards. Tap Next round to continue.",
      {
        reply_markup: inlineKeyboard([
          [inlineButton("▶️ Next round", `game:resolve:${code}`)],
          [inlineButton("🖐 Show hand", "menu:hand")],
        ]),
      },
    );
  } catch {
    // Best-effort
  }
});

// --- Resolve round ---
composer.callbackQuery(/^game:resolve:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const code = ctx.match![1];
  const { resolveRound } = await import("../game/engine.js");

  const result = await resolveRound(code);

  if (!result.ok) {
    await ctx.answerCallbackQuery({ text: result.error ?? "Couldn't resolve round.", show_alert: true });
    return;
  }

  const game = result.game!;
  const players = result.players!;

  // Check for endgame
  if (result.finished) {
    const standings = result.standings!;
    const lines: string[] = ["🏆 Game over!"];
    for (const s of standings) {
      lines.push(`  ${s.label} — Player ${s.seat_index + 1}`);
    }

    await ctx.reply(lines.join("\n"));

    // Announce in group
    try {
      await ctx.api.sendMessage(game.chat_id, lines.join("\n"));
    } catch {
      // Best-effort
    }

    // DM all players
    for (const p of players) {
      try {
        await ctx.api.sendMessage(p.telegram_id, lines.join("\n"));
      } catch {
        // Best-effort
      }
    }

    return;
  }

  // Normal round resolution
  const attacker = players.find(p => p.seat_index === game.current_attacker_index);
  const defender = players.find(p => p.seat_index === game.current_defender_index);

  try {
    await ctx.api.sendMessage(
      game.chat_id,
      `🔄 New round! Deck: ${game.deck.length} cards remaining.\n` +
        `Player ${(attacker?.seat_index ?? 0) + 1} attacks → Player ${(defender?.seat_index ?? 0) + 1} defends.`,
      {
        reply_markup: inlineKeyboard([
          [inlineButton("📋 View table", "menu:table")],
        ]),
      },
    );
  } catch {
    // Best-effort
  }

  // Notify new attacker
  if (attacker) {
    try {
      await ctx.api.sendMessage(
        attacker.telegram_id,
        `⚔️ It's your turn to attack! Player ${(defender?.seat_index ?? 0) + 1} is defending. Check /hand.`,
      );
    } catch {
      // Best-effort
    }
  }

  // Update hand for current player
  await showPlayerHand(ctx, ctx.from!.id, game, players);
});

// --- Leave game ---
composer.callbackQuery("game:leave", leaveGame);
composer.command("leave", leaveGame);

async function leaveGame(ctx: Ctx) {
  if (ctx.callbackQuery) await ctx.answerCallbackQuery();
  const { leaveGame: doLeave } = await import("../game/engine.js");

  const result = await doLeave(ctx.from!.id);

  if (!result.ok) {
    await ctx.reply(result.error ?? "Couldn't leave.", {
      reply_markup: inlineKeyboard([
        [inlineButton("⬅️ Back to menu", "menu:main")],
      ]),
    });
    return;
  }

  await ctx.reply(result.message ?? "Left the game.", {
    reply_markup: inlineKeyboard([
      [inlineButton("⬅️ Back to menu", "menu:main")],
    ]),
  });
}

// --- Helper: show hand as an edit or new message ---
async function showPlayerHand(
  ctx: Ctx,
  userId: number,
  game: import("../game/types.js").Game,
  players: import("../game/types.js").Player[],
) {
  const currentPlayer = players.find(p => p.telegram_id === userId);
  if (!currentPlayer || currentPlayer.hand.length === 0) return;

  // We can't easily edit the original hand message here since we sent a new reply,
  // so just send a brief update. Full hand is available via /hand.
  try {
    await ctx.api.sendMessage(
      userId,
      `🃏 ${currentPlayer.hand.length} cards in hand. Tap /hand to see them.`,
      {
        reply_markup: inlineKeyboard([
          [inlineButton("🖐 Show hand", "menu:hand")],
          [inlineButton("📋 View table", "menu:table")],
        ]),
      },
    );
  } catch {
    // Best-effort — DM may fail
  }
}

export default composer;