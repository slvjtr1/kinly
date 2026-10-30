-- Kinly's shared Trakt app credentials, readable only by the service role (the trakt-oauth Edge
-- Function). The private schema is not exposed through the API.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
create table if not exists private.trakt_app (
  id boolean primary key default true check (id),
  client_id text not null check (client_id ~ '^[A-Za-z0-9_-]{20,128}$'),
  client_secret text not null check (client_secret ~ '^[A-Za-z0-9_-]{20,128}$'),
  updated_at timestamptz not null default now()
);
revoke all on private.trakt_app from public, anon, authenticated;

create or replace function public.trakt_app_credentials()
returns table (client_id text, client_secret text)
language sql security definer set search_path = '' stable as $$
  select t.client_id, t.client_secret from private.trakt_app t where t.id;
$$;
revoke all on function public.trakt_app_credentials() from public, anon, authenticated;
grant execute on function public.trakt_app_credentials() to service_role;
