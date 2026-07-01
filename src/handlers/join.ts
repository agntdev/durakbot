import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import {
  inlineButton,
  inlineKeyboard,
} from "../toolkit/index.js";

const composer = new Composer<Ctx>();

// Handle menu:join callback from main menu
composer.callbackQuery("menu:join", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    "Enter a game code to join.\n\nSend the 4-letter code, or type:\n/join ABCD",
    {
      reply_markup: inlineKeyboard([
        [inlineButton("⬅️ Back to menu", "menu:main")],
      ]),
    },
  );
});

// /join [code] command
composer.command("join", async (ctx) => {
  const { joinGame } = await import("../game/engine.js");
  const { now } = await import("../game/clock.js");
  const { getGamePlayers, getGame } = await import("../game/store.js");

  const userId = ctx.from!.id;
  const code = ctx.match?.toString().trim().toUpperCase();

  if (!code) {
    await ctx.reply(
      "Send the 4-letter game code to join, like:\n/join ABCD",
    );
    return;
  }

  if (code.length !== 4 || !/^[A-Z0-9]{4}$/.test(code)) {
    await ctx.reply(
      "Game codes are 4 letters and numbers. Check the code and try again.",
    );
    return;
  }

  const result = await joinGame(userId, code);

  if (!result.ok) {
    await ctx.reply(result.error ?? "Couldn't join the game.");
    return;
  }

  if (result.error === "You're already in this game.") {
    await ctx.reply("You're already in this game.", {
      reply_markup: inlineKeyboard([
        [inlineButton("⬅️ Back to menu", "menu:main")],
      ]),
    });
    return;
  }

  const game = result.game!;
  const players = await getGamePlayers(game.game_code);
  const playerNames = players.map(p => `Player ${p.seat_index + 1}`).join(", ");

  await ctx.reply(
    `✅ You joined game <b>${game.game_code}</b>!\n\n` +
      `Players (${players.length}/6): ${playerNames}\n\n` +
      `Share this code with friends so they can join.`,
    { parse_mode: "HTML" },
  );

  // Notify the group/lobby chat
  try {
    await ctx.api.sendMessage(
      game.chat_id,
      `Player ${players.length} joined the lobby. ${players.length}/6 players.`,
      {
        reply_markup: inlineKeyboard([
          [inlineButton("🎫 Join", `lobby:join:${game.game_code}`)],
        ]),
      },
    );
  } catch {
    // Group notification is best-effort
  }
});

// Lobby join button (from lobby message)
composer.callbackQuery(/^lobby:join:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const { joinGame } = await import("../game/engine.js");
  const { getGamePlayers } = await import("../game/store.js");

  const code = ctx.match![1];
  const userId = ctx.from!.id;

  const result = await joinGame(userId, code);

  if (!result.ok) {
    await ctx.answerCallbackQuery({ text: result.error ?? "Couldn't join.", show_alert: true });
    return;
  }

  if (result.error === "You're already in this game.") {
    await ctx.answerCallbackQuery({ text: "You're already in this game." });
    return;
  }

  const game = result.game!;
  const players = await getGamePlayers(game.game_code);

  await ctx.answerCallbackQuery({ text: `Joined game ${code}!` });

  // Update lobby message
  try {
    await ctx.editMessageText(
      `🃏 Lobby <b>${game.game_code}</b>\n\nPlayers (${players.length}/6):\n` +
        players.map((p, i) => `  ${i + 1}. Player`).join("\n"),
      {
        parse_mode: "HTML",
        reply_markup: inlineKeyboard([
          [inlineButton("🎫 Join", `lobby:join:${game.game_code}`)],
          [inlineButton("👥 Players", `lobby:players:${game.game_code}`)],
          [inlineButton("▶️ Start game", `lobby:begin:${game.game_code}`)],
        ]),
      },
    );
  } catch {
    // Best-effort edit
  }
});

export default composer;