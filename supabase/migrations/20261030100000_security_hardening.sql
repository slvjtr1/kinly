-- Security hardening:
-- 1. "Recent password sign-in" is read from the password entry of the JWT's `amr` claim. `iat`
--    changes on every token refresh, so it can't tell when the password was last entered.
-- 2. Per-IP rate limiting for the trakt-oauth Edge Function (service role only).
-- 3. Self-service account deletion after a recent password sign-in.

-- True when the caller signed in with their password in the last `max_age_sec` seconds.
create or replace function public.recent_password_auth(max_age_sec int default 300) returns boolean
language sql stable security invoker set search_path = '' as $$
  select exists (
    select 1
    from jsonb_array_elements(
      case when jsonb_typeof((select auth.jwt()) -> 'amr') = 'array' then (select auth.jwt()) -> 'amr' else '[]'::jsonb end
    ) as e
    where e ->> 'method' = 'password'
      and (e ->> 'timestamp') ~ '^[0-9]{1,12}$'
      and (e ->> 'timestamp')::bigint > extract(epoch from now()) - max_age_sec
      and (e ->> 'timestamp')::bigint <= extract(epoch from now()) + 60
  );
$$;
revoke all on function public.recent_password_auth(int) from public, anon;
grant execute on function public.recent_password_auth(int) to authenticated;

-- Sets or changes a PIN. Changing or removing one needs the current PIN, or a password sign-in in
-- the last 5 minutes ("forgot PIN").
create or replace function public.set_profile_pin(p_profile uuid, p_pin text, p_current text default null) returns text
language plpgsql security definer set search_path = '' as $$
declare has boolean; v text;
begin
  if not public.owns_profile(p_profile) then raise exception 'not allowed'; end if;
  if p_pin is not null and p_pin !~ '^[0-9]{4,8}$' then return 'invalid'; end if;
  has := exists (select 1 from public.profile_pins where profile_id = p_profile);
  if has and not public.recent_password_auth(300) then
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
revoke all on function public.set_profile_pin(uuid, text, text) from public, anon;
grant execute on function public.set_profile_pin(uuid, text, text) to authenticated;

-- Request counters for the trakt-oauth relay, keyed by a hash of the client IP (the IP itself is
-- not stored). Rows older than a day are removed as new ones arrive.
create table if not exists private.relay_hits (
  ip_hash text not null,
  window_start timestamptz not null,
  hits int not null default 0,
  primary key (ip_hash, window_start)
);
revoke all on private.relay_hits from public, anon, authenticated;

-- Counts one request and answers whether it is within `p_limit` per `p_window_sec` seconds.
create or replace function public.relay_allow(p_ip_hash text, p_limit int, p_window_sec int) returns boolean
language plpgsql security definer set search_path = '' as $$
declare w timestamptz; n int;
begin
  if p_ip_hash !~ '^[0-9a-f]{16,128}$' or p_limit < 1 or p_window_sec < 1 then return false; end if;
  w := to_timestamp(floor(extract(epoch from now()) / p_window_sec) * p_window_sec);
  insert into private.relay_hits as h (ip_hash, window_start, hits) values (p_ip_hash, w, 1)
    on conflict (ip_hash, window_start) do update set hits = h.hits + 1
    returning hits into n;
  if random() < 0.01 then
    delete from private.relay_hits where window_start < now() - interval '1 day';
  end if;
  return n <= p_limit;
end $$;
revoke all on function public.relay_allow(text, int, int) from public, anon, authenticated;
grant execute on function public.relay_allow(text, int, int) to service_role;

-- Deletes the caller's account. Profiles, libraries, PINs and synced settings go with it
-- (on delete cascade). Needs a password sign-in in the last 5 minutes.
create or replace function public.delete_my_account() returns text
language plpgsql security definer set search_path = '' as $$
declare uid uuid := (select auth.uid());
begin
  if uid is null then raise exception 'not allowed'; end if;
  if not public.recent_password_auth(300) then return 'reauth'; end if;
  delete from auth.users where id = uid;
  return 'ok';
end $$;
revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;
