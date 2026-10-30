-- Avatars are either a built-in avatar key or a public https image URL (jpg/jpeg/png/webp/gif).
alter table public.profiles drop constraint if exists profiles_avatar_check;
alter table public.profiles add constraint profiles_avatar_check check (
  avatar ~ '^[a-z0-9-]{1,24}$'
  or (char_length(avatar) <= 512 and avatar ~* '^https://[a-z0-9.-]+(:[0-9]{2,5})?/[^\s"''<>\\]*\.(jpe?g|png|webp|gif)(\?[^\s"''<>\\]*)?$')
);
