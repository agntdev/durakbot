import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import {
  inlineButton,
  inlineKeyboard,
} from "../toolkit/index.js";
import { getPlayer, getGame, getGamePlayers } from "../game/store.js";
import {
  cardDisplay,
  cardKey,
  SUIT_EMOJI,
} from "../game/types.js";
import type { Card } from "../game/types.js";
import { isPlayableAttack, canBeat } from "../game/deck.js";

const composer = new Composer<Ctx>();

// Main menu route
composer.callbackQuery("menu:hand", showHand);
composer.command("hand", showHand);

async function showHand(ctx: Ctx) {
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
  const currentPlayer = players.find(p => p.telegram_id === userId);
  if (!currentPlayer) {
    await ctx.reply("You're not in this game anymore.", {
      reply_markup: inlineKeyboard([
        [inlineButton("⬅️ Back to menu", "menu:main")],
      ]),
    });
    return;
  }

  if (currentPlayer.hand.length === 0) {
    const status = currentPlayer.status === "finished"
      ? "You've finished this game — no cards left."
      : "You have no cards right now.";

    await ctx.reply(status, {
      reply_markup: inlineKeyboard([
        [inlineButton("📋 View table", "menu:table")],
        [inlineButton("⬅️ Back to menu", "menu:main")],
      ]),
    });
    return;
  }

  const isAttacker = game.attacker_ids.includes(currentPlayer.seat_index) && !game.passed_ids.includes(currentPlayer.seat_index);
  const isDefender = currentPlayer.seat_index === game.current_defender_index && !game.round_over;
  const isRoundOver = game.round_over;

  const handDisplay = currentPlayer.hand
    .map(c => `${SUIT_EMOJI[c.suit]}${c.rank}`)
    .join("  ");

  const lines: string[] = [
    `🃏 Your hand (${currentPlayer.hand.length} cards)`,
    "",
    handDisplay,
    "",
    `Trump: ${SUIT_EMOJI[game.trump_suit]} ${game.trump_suit}`,
  ];

  const buttons: ReturnType<typeof inlineButton>[][] = [];

  if (game.status === "playing") {
    if (isAttacker && !game.round_over) {
      const playableCards = currentPlayer.hand.filter(c => isPlayableAttack(c, game.table_cards));
      if (playableCards.length > 0) {
        buttons.push([inlineButton("⚔️ Attack with:", "noop")]);
        for (const card of playableCards) {
          buttons.push([
            inlineButton(
              `${SUIT_EMOJI[card.suit]}${card.rank}`,
              `game:attack:${game.game_code}:${cardKey(card)}`,
            ),
          ]);
        }
      }
      if (game.table_cards.length > 0) {
        buttons.push([inlineButton("✅ Pass", `game:pass:${game.game_code}`)]);
      }
    }

    if (isDefender && !game.round_over && game.table_cards.length > 0) {
      buttons.push([inlineButton("🛡️ Defend:", "noop")]);
      for (let i = 0; i < game.table_cards.length; i++) {
        const tc = game.table_cards[i];
        if (tc.defense) continue;
        const beatCards = currentPlayer.hand.filter(c =>
          canBeat(tc.attack, c, game.trump_suit),
        );
        for (const card of beatCards) {
          buttons.push([
            inlineButton(
              `vs ${SUIT_EMOJI[tc.attack.suit]}${tc.attack.rank} → ${SUIT_EMOJI[card.suit]}${card.rank}`,
              `game:defend:${game.game_code}:${i}:${cardKey(card)}`,
            ),
          ]);
        }
      }
      buttons.push([inlineButton("🤲 Take all", `game:take:${game.game_code}`)]);
    }

    if (isRoundOver && isDefender) {
      buttons.push([inlineButton("▶️ Next round", `game:resolve:${game.game_code}`)]);
    }
  }

  buttons.push([inlineButton("📋 View table", "menu:table")]);
  buttons.push([inlineButton("⬅️ Back to menu", "menu:main")]);

  const msgText = lines.join("\n");
  await ctx.reply(msgText, { reply_markup: inlineKeyboard(buttons) });
}

// Catch noop callback (informational buttons we don't need to handle)
composer.callbackQuery("noop", async (ctx) => {
  await ctx.answerCallbackQuery();
});

export default composer;
