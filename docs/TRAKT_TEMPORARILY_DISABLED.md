# Trakt in Kinly 1.1.0 Beta

Trakt integration has been temporarily disabled in Kinly 1.1.0 Beta due to temporary technical issues. This is not a permanent removal. Trakt integration is planned to return in future updates.

No return date has been set.

## What is switched off

One flag, `FEATURES.trakt` in `src/lib/features.ts`, is `false` in this release. With it off:

- No Trakt section in Settings → Connections, and no Trakt wording in the account, profile
  or "copy connections" texts.
- No network requests to `api.trakt.tv` or to Kinly's Trakt sign-in relay: no automatic sync
  at startup or every 15 minutes, no "Sync now", no scrobbling during playback, no token
  revocation (`startTraktConnect`, `traktSyncNow`, `traktScrobble` and the auto-sync timer
  all return without doing anything). `tests/trakt-disabled.test.ts` checks this.
- An old link to Settings → Trakt opens Settings → Connections.

## What is kept

- **All code**: `src/lib/trakt.ts`, `TraktSettings` in `src/views/AccountSettings.tsx`, the
  Trakt tests (they run with the flag turned on).
- **Users' data**: each profile's stored Trakt connection (the `trakt` store on the
  computer) is loaded but never changed or deleted. Deleting a profile still removes that
  profile's local Trakt entry, as before, without contacting Trakt.
- **The backend**: the Supabase Edge Function `supabase/functions/trakt-oauth` (the sign-in
  relay), the `trakt_app_credentials` migration and the relay's secrets stay deployed. No
  database objects were dropped.

## Turning it back on

1. Set `trakt: true` in `src/lib/features.ts`.
2. Check the relay still answers: the Edge Function `trakt-oauth` must be deployed with the
   secrets `TRAKT_CLIENT_ID`, `TRAKT_CLIENT_SECRET` and `KINLY_CLIENT_KEYS` (see
   `docs/BUILDING.md`, Supabase section). Never commit their values.
3. Run `npm test` (the Trakt suites cover connect, import, scrobble and profile handling).
4. Restore the Trakt rows in the README (features and privacy table) and add a changelog
   entry.

Connections that users made in Kinly 1.0.x work again without signing in a second time,
unless Trakt has expired or revoked the tokens in the meantime.
