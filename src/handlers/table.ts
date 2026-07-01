import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import {
  inlineButton,
  inlineKeyboard,
} from "../toolkit/index.js";
import { getPlayer, getGame, getGamePlayers } from "../game/store.js";
import { cardDisplay, SUIT_EMOJI } from "../game/types.js";

const composer = new Composer<Ctx>();

composer.callbackQuery("menu:table", showTable);
composer.command("table", showTable);

async function showTable(ctx: Ctx) {
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

  const game = await getGame(player.game_code);
  if (!game) {
    await ctx.reply("Game not found.", {
      reply_markup: inlineKeyboard([
        [inlineButton("⬅️ Back to menu", "menu:main")],
      ]),
    });
    return;
  }

  const players = await getGamePlayers(game.game_code);

  // Table state
  const tableLines: string[] = [];
  tableLines.push(`📋 Table — Game ${game.game_code}`);
  tableLines.push("");

  // Trump
  tableLines.push(`Trump: ${SUIT_EMOJI[game.trump_suit]} ${game.trump_suit}`);
  tableLines.push(`Deck: ${game.deck.length} cards | Discard: ${game.discard.length}`);

  if (game.status === "lobby") {
    tableLines.push("");
    tableLines.push("Game hasn't started yet — waiting for players.");
    tableLines.push(`Players: ${players.length}/6`);
  } else {
    // Table cards
    tableLines.push("");
    if (game.table_cards.length === 0) {
      tableLines.push("Table: empty");
    } else {
      tableLines.push("Table:");
      for (const tc of game.table_cards) {
        const atk = cardDisplay(tc.attack);
        const def = tc.defense ? cardDisplay(tc.defense) : "❓";
        tableLines.push(`  ⚔️ ${atk} → 🛡️ ${def}`);
      }
    }

    // Players
    tableLines.push("");
    tableLines.push("Players:");
    for (const p of players) {
      const isAttacker = game.attacker_ids.includes(p.seat_index) && !game.passed_ids.includes(p.seat_index);
      const isDefender = p.seat_index === game.current_defender_index;
      const cards = p.hand.length;
      const status = p.status === "finished" ? "✅ done" : p.status === "left" ? "❌ left" : `${cards} cards`;
      let marker = "";
      if (isAttacker && game.status === "playing") marker = " ⚔️";
      if (isDefender && game.status === "playing") marker = " 🛡️";
      if (game.passed_ids.includes(p.seat_index)) marker = " ☑️ passed";
      tableLines.push(`  ${p.seat_index + 1}. Player${marker} — ${status}`);
    }
  }

  const buttons: ReturnType<typeof inlineButton>[][] = [];

  if (game.status === "lobby") {
    buttons.push([inlineButton("🎫 Join", `lobby:join:${game.game_code}`)]);
    buttons.push([inlineButton("▶️ Start game", `lobby:begin:${game.game_code}`)]);
  }
  buttons.push([inlineButton("🖐 My hand", "menu:hand")]);
  if (game.status !== "finished") {
    buttons.push([inlineButton("🚪 Leave game", "game:leave")]);
  }
  buttons.push([inlineButton("⬅️ Back to menu", "menu:main")]);

  await ctx.reply(tableLines.join("\n"), { reply_markup: inlineKeyboard(buttons) });
}

export default composer;