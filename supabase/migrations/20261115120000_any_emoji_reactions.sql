-- Reactions: any standard emoji (2026-11-02). The quick set is 👍 😂 🔥 🏈 🏆 💀 🗑️ and "+" opens the
-- full picker (team emoji too), so the database no longer limits the five original ones: a reaction
-- is one emoji, up to 8 code points (ZWJ sequences, flags, skin tones), no letters, digits, spaces or markup.
alter table public.board_reactions drop constraint if exists board_reactions_emoji_check;
alter table public.board_reactions add constraint board_reactions_emoji_check
  check (char_length(emoji) between 1 and 8 and emoji !~ '[[:alnum:][:space:]<>"''&;/\\]');
alter table public.chat_reactions drop constraint if exists chat_reactions_emoji_check;
alter table public.chat_reactions add constraint chat_reactions_emoji_check
  check (char_length(emoji) between 1 and 8 and emoji !~ '[[:alnum:][:space:]<>"''&;/\\]');
