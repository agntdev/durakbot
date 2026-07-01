import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import {
  registerMainMenuItem,
  mainMenuKeyboard,
} from "../toolkit/index.js";

// Register top-level menu items. Each feature handler registers its own button
// and handles its own callbackQuery route — this file does NOT dispatch them.
registerMainMenuItem({ label: "🃏 New game", data: "menu:newgame", order: 10 });
registerMainMenuItem({ label: "🎫 Join game", data: "menu:join", order: 20 });
registerMainMenuItem({ label: "🖐 My hand", data: "menu:hand", order: 30 });
registerMainMenuItem({ label: "📋 Table", data: "menu:table", order: 40 });
registerMainMenuItem({ label: "👥 Players", data: "menu:players", order: 50 });

const composer = new Composer<Ctx>();

const WELCOME =
  "🃏 Welcome to Durak!\n\n" +
  "A classic Russian card game for 2–6 players. Create or join a game, " +
  "then battle it out — last player with cards is the Durak.\n\n" +
  "Tap a button below to get started.";

composer.command("start", async (ctx) => {
  await ctx.reply(WELCOME, { reply_markup: mainMenuKeyboard() });
});

// "Back to menu" — re-render the main menu in place.
composer.callbackQuery("menu:main", async (ctx) => {
  await ctx.answerCallbackQuery();
  try {
    await ctx.editMessageText(WELCOME, { reply_markup: mainMenuKeyboard() });
  } catch {
    await ctx.reply(WELCOME, { reply_markup: mainMenuKeyboard() });
  }
});

export default composer;