import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import {
  inlineButton,
  inlineKeyboard,
} from "../toolkit/index.js";
import { getPlayer, getGame, getGamePlayers } from "../game/store.js";
import { cardDisplay } from "../game/types.js";

const composer = new Composer<Ctx>();

composer.command("begin", startGameCmd);
composer.callbackQuery(/^lobby:begin:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await doStartGame(ctx, ctx.match![1]);
});

async function startGameCmd(ctx: Ctx) {
  const userId = ctx.from!.id;
  const player = await getPlayer(userId);

  if (!player) {
    await ctx.reply("You're not in a lobby. Create or join one first.", {
      reply_markup: inlineKeyboard([
        [inlineButton("⬅️ Back to menu", "menu:main")],
      ]),
    });
    return;
  }

  await doStartGame(ctx, player.game_code);
}

async function doStartGame(ctx: Ctx, code: string) {
  const { startGame } = await import("../game/engine.js");
  const userId = ctx.from!.id;

  const result = await startGame(code, userId);

  if (!result.ok) {
    await ctx.reply(result.error ?? "Couldn't start the game.", {
      reply_markup: inlineKeyboard([
        [inlineButton("⬅️ Back to menu", "menu:main")],
      ]),
    });
    return;
  }

  const game = result.game!;
  const players = result.players!;
  const attacker = players.find(p => p.seat_index === game.current_attacker_index);
  const defender = players.find(p => p.seat_index === game.current_defender_index);

  // Announce game start in the group chat
  const trumpDisplay = `${cardDisplay(game.trump_card)}`;
  await ctx.reply(
    `🃏 Game started!\n\n` +
      `Trump: ${trumpDisplay}\n` +
      `Deck: ${game.deck.length} cards remaining\n\n` +
      `Player ${(attacker?.seat_index ?? 0) + 1} attacks first → Player ${(defender?.seat_index ?? 0) + 1} defends.`,
    {
      reply_markup: inlineKeyboard([
        [inlineButton("📋 View table", "menu:table")],
        [inlineButton("🖐 My hand", "menu:hand")],
      ]),
    },
  );

  // DM each player their hand
  for (const p of players) {
    try {
      const handText = p.hand.map(c => cardDisplay(c)).join("  ");
      await ctx.api.sendMessage(
        p.telegram_id,
        `🃏 Your hand — ${handText}\n\n` +
          `Trump: ${trumpDisplay}`,
        {
          reply_markup: inlineKeyboard([
            [inlineButton("🖐 Refresh hand", "menu:hand")],
            [inlineButton("📋 View table", "menu:table")],
          ]),
        },
      );
    } catch {
      // DM fallback — user may not have started the bot
      try {
        await ctx.api.sendMessage(
          game.chat_id,
          `Player ${p.seat_index + 1}: I couldn't DM your hand. Make sure you've started the bot and try /hand.`,
        );
      } catch {
        // Best-effort
      }
    }
  }

  // Notify the first attacker via DM
  if (attacker) {
    try {
      await ctx.api.sendMessage(
        attacker.telegram_id,
        "⚔️ It's your turn to attack! Choose a card from your hand to play.",
        {
          reply_markup: inlineKeyboard([
            [inlineButton("🖐 View hand", "menu:hand")],
          ]),
        },
      );
    } catch {
      // Best-effort
    }
  }
}

export default composer;
