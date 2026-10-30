// Runs every migration in an in-memory Postgres with minimal stand-ins for Supabase's auth
// schema and roles, then checks the security-relevant functions and grants.
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const MIGRATIONS = join(__dirname, "..", "supabase", "migrations");
const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const now = () => Math.floor(Date.now() / 1000);

let db: PGlite;

async function as(role: "anon" | "authenticated" | "service_role", claims: object = {}) {
  await db.exec(`reset role`);
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify(claims)]);
  await db.exec(`set role ${role}`);
}
const user = (sub: string, pwAgo?: number) =>
  as("authenticated", {
    sub,
    iat: now(),
    amr: pwAgo === undefined ? [{ method: "refresh_token", timestamp: now() }] : [{ method: "password", timestamp: now() - pwAgo }],
  });
const one = async <T>(sql: string, params: unknown[] = []) => (await db.query<{ r: T }>(sql, params)).rows[0].r;

beforeAll(async () => {
  db = await PGlite.create({ extensions: { pgcrypto } });
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth; create schema extensions;
    create extension pgcrypto schema extensions;
    create table auth.users (id uuid primary key);
    grant usage on schema public, auth, extensions to anon, authenticated, service_role;
    grant execute on all functions in schema extensions to public;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
    create function auth.jwt() returns jsonb language sql stable as
      $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(auth.jwt() ->> 'sub', '')::uuid $$;
  `);
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    await db.exec(readFileSync(join(MIGRATIONS, f), "utf8"));
  }
  await db.exec(`insert into auth.users values ('${U1}'), ('${U2}')`);
});

async function profileWithPin(sub: string, pin: string) {
  await user(sub, 10);
  const id = await one<string>(`insert into public.profiles (name) values ('p') returning id as r`);
  expect(await one(`select public.set_profile_pin($1, $2) as r`, [id, pin])).toBe("ok");
  return id;
}

describe("profile PINs", () => {
  it("needs the current PIN when the last password sign-in is old, even with a fresh token", async () => {
    const id = await profileWithPin(U1, "1234");
    await user(U1, 3600); // token refreshed just now (iat), password entered an hour ago
    expect(await one(`select public.set_profile_pin($1, null, '0000') as r`, [id])).toBe("wrong");
    expect(await one(`select public.set_profile_pin($1, '5678', '1234') as r`, [id])).toBe("ok");
  });

  it("does not treat a refresh-token session as a recent password sign-in", async () => {
    const id = await profileWithPin(U1, "1234");
    await user(U1);
    expect(await one(`select public.set_profile_pin($1, null) as r`, [id])).toBe("wrong");
  });

  it("allows resetting a forgotten PIN after a password sign-in in the last 5 minutes", async () => {
    const id = await profileWithPin(U1, "1234");
    await user(U1, 30);
    expect(await one(`select public.set_profile_pin($1, null) as r`, [id])).toBe("ok");
  });

  it("ignores password timestamps in the future or malformed amr claims", async () => {
    const id = await profileWithPin(U1, "1234");
    await as("authenticated", { sub: U1, amr: [{ method: "password", timestamp: now() + 86400 }] });
    expect(await one(`select public.set_profile_pin($1, null) as r`, [id])).toBe("wrong");
    await as("authenticated", { sub: U1, amr: [{ method: "password", timestamp: "soon" }] });
    expect(await one(`select public.set_profile_pin($1, null) as r`, [id])).toBe("wrong");
    await as("authenticated", { sub: U1, amr: "password" });
    expect(await one(`select public.set_profile_pin($1, null) as r`, [id])).toBe("wrong");
  });

  it("refuses other users' profiles and anonymous callers", async () => {
    const id = await profileWithPin(U1, "1234");
    await user(U2, 10);
    await expect(db.query(`select public.set_profile_pin($1, null)`, [id])).rejects.toThrow(/not allowed/);
    await as("anon");
    await expect(db.query(`select public.set_profile_pin($1, null)`, [id])).rejects.toThrow(/permission denied/);
  });
});

describe("account deletion", () => {
  it("needs a recent password sign-in", async () => {
    await user(U2, 3600);
    expect(await one(`select public.delete_my_account() as r`)).toBe("reauth");
    await user(U2);
    expect(await one(`select public.delete_my_account() as r`)).toBe("reauth");
  });

  it("is not callable anonymously", async () => {
    await as("anon");
    await expect(db.query(`select public.delete_my_account()`)).rejects.toThrow(/permission denied/);
  });

  it("removes the caller's account and every row that belongs to it, and nothing else", async () => {
    await user(U2, 10);
    const pid = await one<string>(`insert into public.profiles (name) values ('mine') returning id as r`);
    await db.query(`insert into public.profile_data (profile_id, library) values ($1, '{}'::jsonb)`, [pid]);
    await db.query(`select public.set_profile_pin($1, '4321')`, [pid]);
    expect(await one(`select public.delete_my_account() as r`)).toBe("ok");

    await db.exec(`reset role`);
    expect(await one(`select count(*)::int as r from auth.users where id = $1`, [U2])).toBe(0);
    for (const t of ["profiles", "profile_data", "profile_pins"]) {
      expect(await one(`select count(*)::int as r from public.${t} where user_id = $1`, [U2])).toBe(0);
    }
    expect(await one(`select count(*)::int as r from auth.users where id = $1`, [U1])).toBe(1);
    expect(await one(`select count(*)::int as r from public.profiles where user_id = $1`, [U1])).toBeGreaterThan(0);
    await db.exec(`insert into auth.users values ('${U2}')`);
  });
});

describe("trakt relay rate limit", () => {
  const ip = "ab".repeat(16);

  it("allows up to the limit per window, then refuses", async () => {
    await as("service_role");
    const results: boolean[] = [];
    for (let i = 0; i < 4; i++) results.push(await one(`select public.relay_allow($1, 3, 3600) as r`, [ip]));
    expect(results).toEqual([true, true, true, false]);
    expect(await one(`select public.relay_allow($1, 3, 3600) as r`, ["cd".repeat(16)])).toBe(true);
  });

  it("rejects malformed keys", async () => {
    await as("service_role");
    expect(await one(`select public.relay_allow('1.2.3.4', 3, 60) as r`)).toBe(false);
  });

  it("is only callable by the service role, and the counters are not readable", async () => {
    for (const role of ["anon", "authenticated"] as const) {
      await as(role, { sub: U1 });
      await expect(db.query(`select public.relay_allow($1, 3, 60)`, [ip])).rejects.toThrow(/permission denied/);
      await expect(db.query(`select * from private.relay_hits`)).rejects.toThrow(/permission denied/);
    }
  });
});

describe("grants", () => {
  it("keeps Trakt app credentials away from clients", async () => {
    for (const role of ["anon", "authenticated"] as const) {
      await as(role, { sub: U1 });
      await expect(db.query(`select * from public.trakt_app_credentials()`)).rejects.toThrow(/permission denied/);
    }
  });

  it("never exposes PIN hashes to clients", async () => {
    await user(U1, 10);
    await expect(db.query(`select pin_hash from public.profile_pins`)).rejects.toThrow(/permission denied/);
  });
});
