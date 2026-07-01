import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { inlineButton, inlineKeyboard } from "../toolkit/index.js";

const composer = new Composer<Ctx>();

const HELP =
  "🃏 Durak — how to play\n\n" +
  "Create or join a lobby, then the host starts the game. Each player gets 6 cards. " +
  "The bottom card of the deck sets the trump suit.\n\n" +
  "Turns: one player attacks, the next defends. Beat attacks with a higher card of " +
  "the same suit, or any trump. If you can't or won't defend, you take all the cards " +
  "on the table.\n\n" +
  "At the end of each round, players draw back up to 6 cards. The last player " +
  "holding cards is the Durak.\n\n" +
  "Tap /start to open the menu.";

const backToMenu = inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]);

composer.command("help", async (ctx) => {
  await ctx.reply(HELP);
});

composer.callbackQuery("menu:help", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(HELP, { reply_markup: backToMenu });
});

export default composer;