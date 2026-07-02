import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import {
  inlineButton,
  inlineKeyboard,
  registerMainMenuItem,
} from "../toolkit/index.js";
import { getPlayer, getGame } from "../game/store.js";
import { ActiveGameError, PlayerInGameError } from "../game/engine.js";

const composer = new Composer<Ctx>();

/** Track in-flight creations per user to prevent duplicate handling from rapid taps. */
const inFlight = new Set<number>();

// Also handle the menu:newgame callback from the /start main menu
composer.callbackQuery("menu:newgame", async (ctx) => {
  await ctx.answerCallbackQuery();
  await handleNewGame(ctx);
});

composer.command("newgame", handleNewGame);

async function handleNewGame(ctx: Ctx) {
  const { createGame } = await import("../game/engine.js");
  const { now } = await import("../game/clock.js");

  const chatId = ctx.chat!.id;
  const userId = ctx.from!.id;

  // Deduplicate rapid repeated taps
  if (inFlight.has(userId)) {
    try {
      await ctx.reply("A game is already being created — please wait a moment.");
    } catch { /* best-effort */ }
    return;
  }
  inFlight.add(userId);

  try {
    // Check if player is already in a game
    const existing = await getPlayer(userId);
    if (existing) {
      const existingGame = await getGame(existing.game_code);
      if (existingGame && existingGame.status !== "finished") {
        await ctx.reply(
          "You're already in a game. Leave it first before creating a new one.",
          {
            reply_markup: inlineKeyboard([
              [inlineButton("⬅️ Back to menu", "menu:main")],
            ]),
          },
        );
        return;
      }
    }

    const isGroup = ctx.chat!.type !== "private";
    const { game } = await createGame(chatId, userId, isGroup);

    await ctx.reply(
      `🃏 Lobby created! Game code: <b>${game.game_code}</b>\n\n` +
        `Players: 1/6 — share the code so friends can join.\n` +
        `Use /join <code> to join, or tap the button below.`,
      {
        parse_mode: "HTML",
        reply_markup: inlineKeyboard([
          [inlineButton("🎫 Join", `lobby:join:${game.game_code}`)],
          [inlineButton("👥 Players", `lobby:players:${game.game_code}`)],
          [inlineButton("▶️ Start game", `lobby:begin:${game.game_code}`)],
          [inlineButton("⬅️ Back to menu", "menu:main")],
        ]),
      },
    );
  } catch (err) {
    if (err instanceof ActiveGameError) {
      await ctx.reply("A game is already active in this chat.", {
        reply_markup: inlineKeyboard([
          [inlineButton("⬅️ Back to menu", "menu:main")],
        ]),
      });
    } else if (err instanceof PlayerInGameError) {
      await ctx.reply("You're already in a game. Leave it first before creating a new one.", {
        reply_markup: inlineKeyboard([
          [inlineButton("⬅️ Back to menu", "menu:main")],
        ]),
      });
    } else {
      // Transient / unknown error — show retry button
      await ctx.reply(
        "Couldn't create the game right now — try again.",
        {
          reply_markup: inlineKeyboard([
            [inlineButton("🔄 Retry", "menu:newgame")],
            [inlineButton("⬅️ Back to menu", "menu:main")],
          ]),
        },
      );
    }
  } finally {
    inFlight.delete(userId);
  }
}

export default composer;
