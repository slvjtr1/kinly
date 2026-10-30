-- Profiles inside one account (like streaming apps). Addons/settings are shared per account,
-- library/watch progress is per profile.
create table public.profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 32),
  avatar text not null default 'ocean' check (avatar ~ '^[a-z0-9-]{1,24}$'),
  created_at timestamptz not null default now()
);
create index profiles_user_id_idx on public.profiles(user_id);

create table public.account_data (
  user_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  addons jsonb not null default '[]'::jsonb check (pg_column_size(addons) < 262144),
  settings jsonb not null default '{}'::jsonb check (pg_column_size(settings) < 65536),
  updated_at timestamptz not null default now()
);

create table public.profile_data (
  profile_id uuid primary key references public.profiles(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  library jsonb not null default '{}'::jsonb check (pg_column_size(library) < 1048576),
  updated_at timestamptz not null default now()
);
create index profile_data_user_id_idx on public.profile_data(user_id);

alter table public.profiles enable row level security;
alter table public.account_data enable row level security;
alter table public.profile_data enable row level security;

create policy "own profiles select" on public.profiles for select to authenticated using ((select auth.uid()) = user_id);
create policy "own profiles insert" on public.profiles for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "own profiles update" on public.profiles for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "own profiles delete" on public.profiles for delete to authenticated using ((select auth.uid()) = user_id);

create policy "own account_data select" on public.account_data for select to authenticated using ((select auth.uid()) = user_id);
create policy "own account_data insert" on public.account_data for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "own account_data update" on public.account_data for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- profile_data rows must belong to a profile the caller owns.
create policy "own profile_data select" on public.profile_data for select to authenticated using ((select auth.uid()) = user_id);
create policy "own profile_data insert" on public.profile_data for insert to authenticated
  with check ((select auth.uid()) = user_id and exists (select 1 from public.profiles p where p.id = profile_id and p.user_id = (select auth.uid())));
create policy "own profile_data update" on public.profile_data for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id and exists (select 1 from public.profiles p where p.id = profile_id and p.user_id = (select auth.uid())));
create policy "own profile_data delete" on public.profile_data for delete to authenticated using ((select auth.uid()) = user_id);

-- No access at all for anonymous callers.
revoke all on public.profiles, public.account_data, public.profile_data from anon;

-- At most 6 profiles per account; user_id and ids cannot be reassigned.
create or replace function public.enforce_profile_rules() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if (select count(*) from public.profiles where user_id = new.user_id) >= 6 then
      raise exception 'An account can have at most 6 profiles';
    end if;
  elsif new.user_id <> old.user_id or new.id <> old.id then
    raise exception 'Profile owner cannot change';
  end if;
  return new;
end $$;
create trigger profiles_rules before insert or update on public.profiles
  for each row execute function public.enforce_profile_rules();

create or replace function public.touch_updated_at() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end $$;
create trigger account_data_touch before update on public.account_data for each row execute function public.touch_updated_at();
create trigger profile_data_touch before update on public.profile_data for each row execute function public.touch_updated_at();
