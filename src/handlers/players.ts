import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import {
  inlineButton,
  inlineKeyboard,
} from "../toolkit/index.js";
import { getPlayer, getGame, getGamePlayers } from "../game/store.js";

const composer = new Composer<Ctx>();

// Main menu route
composer.callbackQuery("menu:players", showPlayers);
composer.command("players", showPlayers);

// Lobby players button
composer.callbackQuery(/^lobby:players:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await showPlayersForCode(ctx, ctx.match![1]);
});

async function showPlayers(ctx: Ctx) {
  // Only answer callback if we came from one
  if (ctx.callbackQuery) await ctx.answerCallbackQuery();

  const userId = ctx.from!.id;
  const player = await getPlayer(userId);

  if (!player) {
    await ctx.reply(
      "You're not in a game. Create or join one first.",
      {
        reply_markup: inlineKeyboard([
          [inlineButton("⬅️ Back to menu", "menu:main")],
        ]),
      },
    );
    return;
  }

  await showPlayersForCode(ctx, player.game_code);
}

async function showPlayersForCode(ctx: Ctx, code: string) {
  const game = await getGame(code);
  if (!game) {
    await ctx.reply("Game not found.", {
      reply_markup: inlineKeyboard([
        [inlineButton("⬅️ Back to menu", "menu:main")],
      ]),
    });
    return;
  }

  const players = await getGamePlayers(code);
  const statusIcon: Record<string, string> = {
    playing: "🟢",
    finished: "✅",
    left: "❌",
  };

  const lines = players.map((p, i) => {
    const icon = statusIcon[p.status] ?? "⚪";
    const marker = p.seat_index === game.current_attacker_index && game.status === "playing" ? " ⚔️" : "";
    const marker2 = p.seat_index === game.current_defender_index && game.status === "playing" ? " 🛡️" : "";
    return `  ${i + 1}. ${icon} Player${marker}${marker2}`;
  });

  const buttons: ReturnType<typeof inlineButton>[][] = [];
  if (game.status === "lobby") {
    buttons.push([inlineButton("🎫 Join", `lobby:join:${code}`)]);
    buttons.push([inlineButton("▶️ Start game", `lobby:begin:${code}`)]);
  }
  buttons.push([inlineButton("⬅️ Back to menu", "menu:main")]);

  const text = `👥 Players — ${game.status === "lobby" ? "Lobby" : "Game"} <b>${code}</b>\n\n${lines.join("\n")}`;

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, {
      parse_mode: "HTML",
      reply_markup: inlineKeyboard(buttons),
    });
  } else {
    await ctx.reply(text, {
      parse_mode: "HTML",
      reply_markup: inlineKeyboard(buttons),
    });
  }
}

export default composer;
