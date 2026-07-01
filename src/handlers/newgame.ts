import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import {
  inlineButton,
  inlineKeyboard,
  registerMainMenuItem,
} from "../toolkit/index.js";
import { getPlayer, getGame } from "../game/store.js";

const composer = new Composer<Ctx>();

// Also handle the menu:newgame callback from the /start main menu
composer.callbackQuery("menu:newgame", async (ctx) => {
  await ctx.answerCallbackQuery();
  // Re-use the command path
  ctx.message = undefined as any;
  await handleNewGame(ctx);
});

composer.command("newgame", handleNewGame);

async function handleNewGame(ctx: Ctx) {
  const { createGame } = await import("../game/engine.js");
  const { now } = await import("../game/clock.js");

  const chatId = ctx.chat!.id;
  const userId = ctx.from!.id;

  // Check if player is already in a game
  const existing = await getPlayer(userId);
  if (existing) {
    const existingGame = await getGame(existing.game_code);
    if (existingGame && existingGame.status !== "finished") {
      await ctx.reply(
        "You're already in a game. Leave it first with Leave Game before creating a new one.",
        {
          reply_markup: inlineKeyboard([
            [inlineButton("⬅️ Back to menu", "menu:main")],
          ]),
        },
      );
      return;
    }
  }

  try {
    const { game } = await createGame(chatId, userId);
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
    await ctx.reply("Couldn't create the game. Try again in a moment.");
  }
}

export default composer;
