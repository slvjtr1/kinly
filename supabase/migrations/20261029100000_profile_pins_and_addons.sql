-- Per-profile addons (each profile has its own list; new profiles may copy the primary's).
alter table public.profile_data add column if not exists addons jsonb
  check (addons is null or pg_column_size(addons) < 262144);

-- Optional profile PINs. Hashes are never readable by clients: no RLS policies exist on this
-- table, and every access goes through the security-definer functions below, which check that
-- the caller owns the profile and rate-limit wrong guesses.
create table if not exists public.profile_pins (
  profile_id uuid primary key references public.profiles(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  pin_hash text not null,
  failed int not null default 0,
  locked_until timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.profile_pins enable row level security;
revoke all on public.profile_pins from public, anon, authenticated;

-- Internal helper for the PIN functions; not callable through the API.
create or replace function public.owns_profile(p_profile uuid) returns boolean
language sql security definer set search_path = '' stable as $$
  select exists (select 1 from public.profiles p where p.id = p_profile and p.user_id = (select auth.uid()));
$$;
revoke all on function public.owns_profile(uuid) from public, anon, authenticated;

-- Which of my profiles have a PIN.
create or replace function public.profile_pin_status() returns table (profile_id uuid, has_pin boolean)
language sql security definer set search_path = '' stable as $$
  select p.id, exists (select 1 from public.profile_pins k where k.profile_id = p.id)
  from public.profiles p where p.user_id = (select auth.uid());
$$;

-- Checks a PIN. 5 wrong guesses lock the profile for 5 minutes, doubling after that (max 1 day).
create or replace function public.verify_profile_pin(p_profile uuid, p_pin text) returns text
language plpgsql security definer set search_path = '' as $$
declare k public.profile_pins;
begin
  if not public.owns_profile(p_profile) then raise exception 'not allowed'; end if;
  select * into k from public.profile_pins where profile_id = p_profile for update;
  if not found then return 'ok'; end if;
  if k.locked_until is not null and k.locked_until > now() then return 'locked'; end if;
  if p_pin ~ '^[0-9]{4,8}$' and extensions.crypt(p_pin, k.pin_hash) = k.pin_hash then
    update public.profile_pins set failed = 0, locked_until = null where profile_id = p_profile;
    return 'ok';
  end if;
  update public.profile_pins set failed = k.failed + 1,
    locked_until = case when k.failed + 1 >= 5
      then now() + least(interval '1 day', interval '5 minutes' * power(2, k.failed + 1 - 5)) end
    where profile_id = p_profile;
  return 'wrong';
end $$;

-- Sets or changes a PIN. Changing or removing one needs the current PIN, or a sign-in with the
-- account password in the last 5 minutes ("forgot PIN").
create or replace function public.set_profile_pin(p_profile uuid, p_pin text, p_current text default null) returns text
language plpgsql security definer set search_path = '' as $$
declare has boolean; fresh boolean; v text;
begin
  if not public.owns_profile(p_profile) then raise exception 'not allowed'; end if;
  if p_pin is not null and p_pin !~ '^[0-9]{4,8}$' then return 'invalid'; end if;
  has := exists (select 1 from public.profile_pins where profile_id = p_profile);
  fresh := coalesce(((select auth.jwt()) ->> 'iat')::bigint, 0) > extract(epoch from now()) - 300
           and coalesce((select auth.jwt()) -> 'amr', '[]'::jsonb) @> '[{"method":"password"}]';
  if has and not fresh then
    v := public.verify_profile_pin(p_profile, coalesce(p_current, ''));
    if v <> 'ok' then return v; end if;
  end if;
  if p_pin is null then
    delete from public.profile_pins where profile_id = p_profile;
  else
    insert into public.profile_pins (profile_id, user_id, pin_hash)
      values (p_profile, (select auth.uid()), extensions.crypt(p_pin, extensions.gen_salt('bf', 8)))
      on conflict (profile_id) do update set pin_hash = excluded.pin_hash, failed = 0, locked_until = null, updated_at = now();
  end if;
  return 'ok';
end $$;

revoke all on function public.profile_pin_status() from public, anon;
revoke all on function public.verify_profile_pin(uuid, text) from public, anon;
revoke all on function public.set_profile_pin(uuid, text, text) from public, anon;
grant execute on function public.profile_pin_status() to authenticated;
grant execute on function public.verify_profile_pin(uuid, text) to authenticated;
grant execute on function public.set_profile_pin(uuid, text, text) to authenticated;
