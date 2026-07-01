# Telegram Durak Bot — Bot specification

**Archetype:** custom

**Voice:** professional and concise — write every user-facing message, button label, error, and empty state in this voice.

A Telegram-only multiplayer bot implementing classic Russian Durak for 2–6 players. Combines public group chat game status with private hand DMs, using inline buttons for actions. Game state stored in Supabase with Telegram integration for messaging.

> This is the complete contract for the bot. Implement EVERY entry point, flow, feature, integration, and edge case below. The completeness review checks the bot against this document after each build pass.

## Primary audience

- casual Telegram users
- board/card game enthusiasts
- group chat players

## Success criteria

- Players can create/join games via /newgame and /join
- Game state transitions validate server-side
- Private hand DMs with interactive buttons work reliably
- Endgame detection and winner announcements function correctly

## Entry points

Every feature must be reachable from the bot's command/button surface (button-first; only /start and /help are slash commands).

- **/start** (command, actor: user, command: /start) — Open welcome/help and main menu
- **/newgame** (command, actor: user, command: /newgame) — Create new lobby with generated code
- **/join** (command, actor: user, command: /join) — Join existing lobby using code
- **/players** (command, actor: user, command: /players) — Show current lobby players
- **/begin** (command, actor: user, command: /begin) — Start game when 2–6 players joined
- **/hand** (command, actor: user, command: /hand) — Request private hand view
- **/table** (command, actor: user, command: /table) — Show table state in DM or group
- **Join Lobby** (button, actor: user, callback: lobby:join) — Join game from lobby message
- **Leave Game** (button, actor: user, callback: game:leave) — Leave current game

## Flows

### Lobby creation
_Trigger:_ /newgame

1. Generate game code
2. Post lobby message with join button
3. Track players in group chat

_Data touched:_ Game, Player

### Attack phase
_Trigger:_ Attack button press

1. Validate attacker's turn
2. Show playable ranks
3. Record attack cards
4. Update table state

_Data touched:_ TableCards, Game

### Defense phase
_Trigger:_ Defend/Take button press

1. Validate defender's turn
2. Process card beat or take
3. Update discard pile
4. Rotate attacker

_Data touched:_ TableCards, Game

### Endgame detection
_Trigger:_ Player discards all cards

1. Check deck/finish conditions
2. Announce Durak or draw
3. Post final standings

_Data touched:_ Game, Player

## Data entities

Durable data (must survive a restart) uses the toolkit's persistent store, never in-memory maps.

- **Game** _(retention: persistent)_ — Match state including deck, trump, players, and turn data
  - fields: game_code, trump_suit, deck, discard, table_cards, current_attacker_index, status
- **Player** _(retention: persistent)_ — User in game with hand and status
  - fields: telegram_id, seat_index, hand, status
- **Card** _(retention: session)_ — Individual card with rank and suit
  - fields: rank, suit
- **TableCards** _(retention: session)_ — Attack/defense pairs in play
  - fields: attack_card, defense_card
- **Action** _(retention: persistent)_ — User actions for audit/recovery
  - fields: player_id, action_type, timestamp

## Integrations

- **Telegram** (required) — Messaging, inline buttons, and user DMs
- **Supabase** (required) — Persistent game state storage
Call external APIs against their real contract (correct endpoints, ids, params); credentials from env. Do not fake responses.

## Owner controls

- Game code generation
- Supabase database schema
- Telegram bot token management
- DM fallback handling for inactive users

## Notifications

- Public group chat game status updates
- Private hand DMs with interactive buttons
- Turn notifications via DM
- Endgame announcements in group chat

## Permissions & privacy

- Private hands only visible in DMs
- Button actions validated by server-side state
- Game code access required for joining

## Edge cases

- DM delivery failure (fallback to group notice)
- Multiple players finishing simultaneously
- Invalid card selection during attack/defense
- Deck exhaustion during refill phase

## Required tests

- Attack with invalid rank validation
- Defender taking cards flow
- Endgame detection with multiple finishers
- Seat rotation after defense/take

## Assumptions

- 36-card deck with 6–A ranks
- Deterministic shuffle for fairness
- Clockwise rotation based on seat index
- First attacker selected by lowest trump or random
