# Kinly accounts, profiles, cloud sync and Trakt

Kinly works fully offline as a **guest**. Signing in to a Kinly account (Supabase) adds
streaming-app style **profiles** and syncs your data between computers. **Trakt** is a separate,
optional connection: users click *Connect* and enter a code on trakt.tv/activate.

## What is stored where

| Data | Where | Notes |
| --- | --- | --- |
| Access token, refresh token, expiry (or `guest: true`) | `account` store, file mode 0600 | Never the password. The email is kept in memory only, read from `/auth/v1/user`. |
| Last profile, cached profile list, each profile's offline library and offline addon list, which profiles have a PIN, the guest library snapshot, sync bookkeeping | `profile` store | Lets you switch profile or sign out without losing a library. |
| The active owner's library (watchlist, progress, deletion tombstones) | `library` store | Always the offline copy, used whether or not you're online. Local files you played (their paths, names and thumbnails) are kept only here and in the `profile` store's offline copies; they are never uploaded. |
| Guest mode's installed addons | `addons` store | Only used while not signed in. |
| Trakt Client ID/Secret and OAuth tokens, **per profile** | `trakt` store, file mode 0600: `{v: 2, profiles: {[profileId \| "guest"]: {...}}}` | Never hardcoded and never synced to Kinly's cloud. |
| TMDB API key, **per profile** | `credentials` store, file mode 0600: `{v: 2, profiles: {[profileId \| "guest"]: {tmdb: {key}}}}` | Never synced; only sent to api.themoviedb.org. |
| Synced settings | Supabase `account_data` (one row per account) | Shared by every profile. Its `addons` column is the account-wide list used by early beta builds; Kinly only reads it to seed profiles. |
| Profiles (name, avatar key or image link) | Supabase `profiles` (max 6, enforced by a trigger) | Built-in avatars are original inline SVGs (`src/views/avatars.tsx`), grouped in the picker as Classics, Animals, Robots & Space, Characters and Abstract. Stored keys never change meaning; old emoji keys map to a character. |
| Each profile's library and installed addons | Supabase `profile_data` (one row per profile, deleted with the profile): `library`, `addons` | Movies and series only: local-file entries, the stream or file a title was last played from, and thumbnails made from local files are left out. **Addon URLs can contain debrid/API keys**; only the account can read them (RLS). |
| Profile PIN hashes | Supabase `profile_pins` | No client can read this table; see *Profile PINs*. |

Synced settings: theme, reduce motion, all subtitle settings, resume, seek step, audio languages,
autoplay next, watched threshold. Settings tied to the device stay local: volume, hardware decoding,
interface size and local media folders. Settings are still per account, not per profile.

On Linux every store file is created owner-only (mode 0600, in a 0700 folder). On Windows the files
live in your user profile, which other standard users can't read.

## Standalone profiles

Every profile, and guest mode, has its own:

| | Stored | Synced |
| --- | --- | --- |
| Library: watchlist, progress/history | `profile_data.library` + local cache | yes |
| Installed addons (and their order) | `profile_data.addons` + local copy in the `profile` store | yes |
| Trakt connection (tokens, optional own Trakt app id/secret) | `trakt` store entry | no, this computer only |
| TMDB key | `credentials` store entry | no, this computer only |

The active "owner" (`"guest"` or a profile id, `src/lib/owner.ts`) is set by `sync.ts` whenever it
swaps the library. Trakt, TMDB and the addon list follow it. Switching profile cancels a Trakt
connect in progress, drops a Trakt import that was still running for the previous profile, and
restarts Trakt auto-sync for the new one. Deleting a profile forgets its Trakt connection (revoked
unless another profile still uses the same token) and TMDB key on this computer.

**Upgrading from a beta build:**

- A v1 `trakt` or `credentials` file (one connection for everyone) is moved into whichever owner is
  active first after the update (the last profile, or guest mode). Other profiles start without one.
- A profile whose `profile_data.addons` is `null` (profiles created by early beta builds) is seeded on
  its first sync from `account_data.addons` (the old shared list), else from the guest list on this
  computer, else the defaults (Cinemeta + OpenSubtitles), and the seed is uploaded.
- Early beta builds still read and write `account_data.addons`; Kinly 1.0.0 never writes it, so
  changes made in such a build after the update don't reach the profiles (and the reverse).
- Library copies uploaded by beta builds may include local-file entries; Kinly 1.0.0 ignores them
  and replaces the cloud copy with one that leaves them out on the next sync.

**Creating a profile** (*Add profile*) offers, relative to the **primary profile** (the account's
oldest one, shown first):

- **Copy addons from <primary>** (on by default). Off: the new profile starts with the default
  addons. The list is written to the new profile's `profile_data.addons` right away.
- **Copy Trakt and TMDB connections from <primary>** (off by default). Copies the primary's Trakt
  tokens and own-app id/secret and its TMDB key **on this computer only** (they are never
  uploaded). Both profiles then use the same Trakt account; a token refresh by either one updates
  both copies, and disconnecting one doesn't revoke the token the other still uses.
- If the primary has a PIN, either copy option first needs the primary's PIN (`verify_profile_pin`).
  Wrong and locked answers are shown and nothing is created.
- An optional PIN for the new profile (entered twice).

## Profile PINs

A PIN is a **household lock**: it stops other people using the same Kinly account from opening a
profile in Kinly. The UI says so wherever a PIN is set. It is not account security.

- 4 to 8 digits. Hashed with bcrypt in `profile_pins`, which has no RLS policies and no grants, so
  no client can read it; everything goes through security-definer RPCs that check the caller owns
  the profile (`profile_pin_status`, `verify_profile_pin`, `set_profile_pin`). PINs are never
  logged or stored on the device.
- Opening a PIN profile (the *Who's watching?* picker, the profile menu, and auto-opening the last
  profile at launch) shows a PIN pad; the profile only opens after the server answers `ok`. The
  lock badge marks PIN profiles. Deleting a PIN profile also asks for its PIN.
- 5 wrong guesses lock the profile for 5 minutes, doubling up to a day. The server only answers
  `locked`, so the "try again in N min" shown is an estimate from the wrong guesses made in this
  session (at least 1 minute).
- Changing or removing a PIN needs the current PIN. **Forgot PIN?** (on the PIN pad, and in
  *Edit profile*) asks for the account password, signs in again, and then (within 5 minutes) sets
  or clears the PIN without the current one. From the pad, the profile then opens. The server
  reads the time of the password sign-in from the `password` entry of the access token's `amr`
  claim; a token refresh doesn't count as a new sign-in.
- Which profiles have a PIN is cached on the device, so a PIN profile stays locked offline (it can't
  be opened until the PIN can be checked). If a profile opened from a stale cache turns out to have
  a PIN, Kinly closes it and asks for the PIN.

Limits, by design:

- Anyone with the account password can reset a PIN, and anyone who can use the account's session
  on this computer can read every profile's cloud data with the REST API: RLS is per account, not
  per profile. The PIN only gates Kinly's UI.
- While the PIN pad shows at launch, the last profile's library is already loaded underneath (it is
  the offline copy on disk), but the app is covered and inert.
- Local connection files (`trakt`, `credentials`) are readable by the computer's user account (and
  only by it); the PIN doesn't encrypt them.

## Security model

- **Row-level security** is on for every table. The `anon` role has no grants, so a request
  with only the publishable key gets `401 permission denied`. You can check this with
  `KINLY_LIVE=1 npx vitest run tests/supabase-live.test.ts`. The `authenticated` role can only
  touch rows where `user_id = auth.uid()`, and `profile_data` rows must point at a profile the user
  owns. The publishable key in `src/lib/supabaseConfig.ts` is public by design. A service-role key
  must never ship in the client.
- **Transport:** every request goes through the Rust HTTP client (`http()` in `src/lib/tauri.ts`)
  over HTTPS. No supabase-js, no `window.fetch` to remote hosts, no telemetry.
- **Tokens:** the access token is refreshed about 90 s before it expires, and again after any 401.
  Refreshes run one at a time, so rotated refresh tokens are never reused. If the server rejects the
  refresh token, Kinly signs out locally. A network error keeps the session and marks it "offline".
  Kinly decodes the access token's `exp`, `sub` (UUID) and `iss` and checks them, but leaves the
  signature check to the server.
- **Sign out** calls `/auth/v1/logout?scope=local`, which revokes this device's refresh token on the
  server, then deletes the local copy. If you're offline, the local copy is still deleted.
- **Passwords:** the client requires at least 10 characters (bcrypt allows at most 72), more than
  one character class, and a password that isn't in an embedded list of common passwords or built
  from your email name. A strength meter shows the score. The server's own policy applies as well;
  see the dashboard settings below.
- **Brute force:** after the second failed sign-in in a row, the client makes you wait
  2 s, 4 s, 8 s and so on, up to 5 min. Supabase's server-side rate limits apply on top of that.
- **No account enumeration:** sign-in failures always show the same message. Sign-up shows
  "Check your email" whether or not the address already has an account. Password recovery always
  says "If an account exists…". Error text from the server is never shown or logged, because it can
  contain the email.
- **Logging:** tokens, passwords and emails are never logged. Log lines only say things like
  "sync: profile_data HTTP 500".
- **Untrusted server data:** profiles, libraries, addons and settings from the server are validated
  before use. That covers types, lengths, UUIDs, avatar keys, `key === type:videoId`, timestamps
  (capped at now + 1 day so a bad clock can't win every merge), image URLs (`https:`, `http:` or
  `asset:` only; images served from the device are never uploaded), and the number and size of entries. Settings go through `sanitizeSettings`, and
  only the keys listed above are applied.
- **Size caps before upload:** libraries are kept under about 900 KB (the server limit is 1 MB).
  When a library is too big, the oldest watched history is dropped from the upload first; the local
  copy is never trimmed. Addons are capped at 240 KB (manifests are dropped and fetched again if
  needed) and settings at 60 KB.
- **Deleting data:** Settings → Account offers two options. Both keep files and the guest
  library on the computer, remove this computer's copies of the account's profiles, and sign you out.
  - *Delete cloud data* deletes every profile, which cascades to their libraries, addons and PINs,
    and empties `account_data`. The account itself stays.
  - *Delete account* asks for the password, signs in again with it, and calls `delete_my_account()`.
    That security-definer function deletes the caller's own `auth.users` row, which cascades to
    every table above, and only runs within 5 minutes of a password sign-in (the same `amr` check as
    PIN resets). It can't delete anyone else's account.

## Sync behaviour

- Kinly pulls when you sign in, when you switch profile, and every 10 minutes. It pushes about 3 s
  after a change. *Sync now* in Settings does both immediately.
- **Library:** merged entry by entry. For each id, the version with the newer `addedAt` (watchlist)
  or `updatedAt` (progress) wins, and fields missing from the winner are filled in from the other
  copy. Deletions are stored as tombstones, so removing an item on one device removes it everywhere
  without bringing it back. Tombstones are kept for 180 days. Before every upload, Kinly fetches the
  server copy and merges it first.
- **Concurrent edits:** uploads are conditional on the row's `updated_at` being the one Kinly just
  read. If another computer wrote in between, nothing is overwritten: Kinly reads the row again,
  merges again and retries (up to three times, then the next sync tries again).
- **Settings:** last write wins. Kinly compares the server's `updated_at` with the time of the last
  local edit. The first time an account syncs on a computer, the account's settings are applied.
- **Addons (per profile):** reconciled three-way against the list both sides last agreed on: if
  only one side changed, it wins; if both changed, the newer edit wins. Addons whose manifest can't
  be fetched are kept in the list (not dropped) and shown once they can be.
- **First sign-in:** the guest library is merged into the first profile you open, once per account
  on each computer. A snapshot of the guest library is kept and comes back when you sign out.
- **Switching profile:** the current profile's library is uploaded and cached locally first, then
  the next one is loaded from its local cache and merged with the server copy.

## Trakt

By default Kinly uses one shared Trakt app. Its secret can't live in a desktop app, so the Edge
Function `trakt-oauth` (`supabase/functions/trakt-oauth`) holds it and relays only Trakt's four
OAuth endpoints (device code, device token, token refresh, revoke). It stores and logs nothing.
API calls after sign-in go straight from the app to Trakt with the user's own token.

Abuse protection: anyone can call a public endpoint, so the relay only forwards those four
endpoints with an allowlisted set of fields, requires Kinly's client key in the `apikey` header,
and allows each client IP 40 requests a minute (enough for device-code polling). The counters are
kept in `private.relay_hits` under a salted hash of the IP, through the service-role-only
`relay_allow()` function, with an in-memory limit per function instance as a fallback. The client
key ships inside the app, so it keeps out casual callers rather than proving the caller is Kinly.

One-time setup by the project owner:

1. Create an app at <https://trakt.tv/oauth/applications> named "Kinly" with the redirect URI
   `http://localhost` (the device flow never uses it, but Trakt requires one).
2. In Supabase → Edge Functions → Secrets, set `TRAKT_CLIENT_ID` and `TRAKT_CLIENT_SECRET`, and
   `KINLY_CLIENT_KEYS` to the publishable key(s) the app is built with (comma-separated). Without
   `KINLY_CLIENT_KEYS` the relay falls back to the publishable keys the runtime provides, if any,
   and otherwise doesn't check the key (the rate limit still applies).
3. Apply the migrations (`supabase db push`) and deploy with `supabase functions deploy
   trakt-oauth`. `supabase/config.toml` turns off the gateway's JWT check for this function:
   publishable keys aren't JWTs, and the function does its own checks.

Advanced users can still use their own Trakt app (Settings → Trakt → *Advanced*); then the app
talks to Trakt directly and the relay is not used.

Connecting: click *Connect*. Kinly shows a code to enter at trakt.tv/activate, then polls
   `/oauth/device/token` at the interval Trakt asks for. The responses mean: 400 still waiting,
   404 invalid code, 409 already used, 410 expired, 418 denied, and 429 poll more slowly (the
   interval grows by 5 s).

Tokens refresh automatically: when less than an hour is left, and again after a 401. *Disconnect*
revokes the token with `/oauth/revoke`.

Each profile (and guest mode) connects its own Trakt account; see *Standalone profiles*.
When Kinly syncs with Trakt, it imports your watchlist (movies and shows) and your watched history
into the active profile's library. Items are matched by their IMDb `tt…` id. Kinly syncs with
Trakt shortly after it starts, at most every 15 minutes, and when you click *Sync now*.
Scrobbling uses `traktScrobble(kind, item, progressPct)`.

## Supabase dashboard settings (project owner)

Authentication → **Sign In / Providers → Email**

- Keep **Confirm email** on.
- Set the **minimum password length to 10**.
- Set **password requirements** to at least "letters and digits".
- Turn on **Prevent use of leaked passwords** (HaveIBeenPwned) if your plan includes it (Pro and
  above).
- Keep **Secure email change** on.
- Set **Email OTP length** to 6. The app accepts 6 to 10 digits.

Authentication → **URL Configuration**

- Keep the **Site URL** at `http://localhost:3000`. While Kinly waits for a confirmation it
  serves a small "Email confirmed — return to Kinly" page there (loopback only, for up to 30
  minutes) and signs the user in by itself. It also retries sign-in every 15 s, so confirming
  from a phone works too. Links work once; opening one again shows "already used".

Authentication → **Emails → Templates**

- **Reset password:** the email must include the code, `{{ .Token }}`, because Kinly's reset flow
  asks for the 6-digit code instead of opening a link. For example:
  `Your Kinly password reset code is {{ .Token }}. It expires in 1 hour. If you didn't ask for this, ignore this email.`
- **Confirm signup:** keep `{{ .ConfirmationURL }}` and optionally add `{{ .Token }}`. The app
  accepts either the link or the code ("Confirm with code").
- Avoid putting `{{ .Email }}` in subjects, so it doesn't show in lock-screen previews.

Authentication → **Emails → SMTP Settings**

- The built-in sender allows only about **2 emails per hour** for the whole project, and only to
  team addresses on some plans. Configure **custom SMTP** (Resend, Postmark, SES and so on) before
  real users sign up. Then raise **Rate Limits → emails per hour** to match.

Authentication → **Sessions / Rate Limits / Attack protection**

- Keep **refresh token rotation** on. Leave the reuse interval at its default of 10 s.
- The defaults for JWT expiry (3600 s) and the sign-in and verify rate limits are fine.
- **Don't enable CAPTCHA**: the desktop client doesn't implement it, so sign-in would stop working.
