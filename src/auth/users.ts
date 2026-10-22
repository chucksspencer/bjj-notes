// People: who can sign in, their passwords, invite and reset links, and their Siri tokens.
import { randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import type { Queryable } from '../db.js';
import { UserError } from '../services/errors.js';
import { secretsMatch, sha256 } from './provider.js';

export interface User {
  id: number;
  email: string | null;
  name: string | null;
  isOwner: boolean;
}

interface UserRow {
  id: number;
  email: string | null;
  name: string | null;
  is_owner: boolean;
  password_hash: string | null;
}

const toUser = (r: UserRow): User => ({ id: r.id, email: r.email, name: r.name, isOwner: r.is_owner });
const USER_COLS = 'id, email, name, is_owner, password_hash';

// ---------- passwords ----------

const scrypt = (password: string, salt: Buffer, keylen: number, opts: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) =>
    scryptCallback(password.normalize('NFKC'), salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))),
  );
const COST = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/** "scrypt$N$r$p$salt$hash", with salt and hash in base64url. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 32, COST);
  return ['scrypt', COST.N, COST.r, COST.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const key = await scrypt(password, Buffer.from(salt, 'base64url'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: COST.maxmem,
  });
  return timingSafeEqual(key, expected);
}

// Checked against when there's no such user, so a wrong email takes as long as a wrong password.
let dummyHash: Promise<string> | null = null;
const wasteTime = async (password: string) => {
  dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
  await verifyPassword(password, await dummyHash);
};

export const MIN_PASSWORD = 10;

export function checkNewPassword(password: string): void {
  if (password.length < MIN_PASSWORD) throw new UserError(`Use at least ${MIN_PASSWORD} characters for the password.`);
  if (password.length > 200) throw new UserError('That password is too long.');
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function cleanEmail(email: string | null | undefined): string | null {
  const e = (email ?? '').trim().toLowerCase();
  if (!e) return null;
  if (!EMAIL.test(e) || e.length > 254) throw new UserError('That email address doesn’t look right.');
  return e;
}

export function cleanName(name: string | null | undefined): string | null {
  const n = (name ?? '').trim().replace(/\s+/g, ' ');
  if (n.length > 80) throw new UserError('That name is too long.');
  return n || null;
}

// ---------- users ----------

export async function getUser(q: Queryable, id: number): Promise<User | null> {
  const row = (await q.query<UserRow>(`select ${USER_COLS} from users where id = $1`, [id])).rows[0];
  return row ? toUser(row) : null;
}

export async function getOwner(q: Queryable): Promise<User> {
  const row = (await q.query<UserRow>(`select ${USER_COLS} from users where is_owner`)).rows[0];
  if (!row) throw new Error('No owner account (has migration 013 run?).');
  return toUser(row);
}

/**
 * The user an email and password belong to, or null. The owner's password is OWNER_PASSWORD. Until the
 * owner has an email on file, the owner signs in with the password alone (as before there were other
 * people), or with any email not already taken, which then becomes the owner's.
 */
export async function authenticate(q: Queryable, emailInput: string, password: string, ownerPassword: string): Promise<User | null> {
  if (!password) return null;
  const email = (emailInput ?? '').trim().toLowerCase();
  const row = email ? (await q.query<UserRow>(`select ${USER_COLS} from users where lower(email) = $1`, [email])).rows[0] : undefined;
  if (row?.is_owner) return secretsMatch(password, ownerPassword) ? toUser(row) : null;
  if (row) {
    if (row.password_hash && (await verifyPassword(password, row.password_hash))) return toUser(row);
    return null;
  }
  const owner = await getOwner(q);
  if (!owner.email && secretsMatch(password, ownerPassword)) {
    if (email && EMAIL.test(email)) {
      await q.query('update users set email = $2 where id = $1 and email is null', [owner.id, email]);
      return { ...owner, email };
    }
    return owner;
  }
  await wasteTime(password);
  return null;
}

export interface PersonRow extends User {
  createdAt: string;
  lastActiveAt: string | null;
}

/** Everyone, owner first, with when they last used the app or Claude. */
export async function listPeople(q: Queryable): Promise<PersonRow[]> {
  const { rows } = await q.query<UserRow & { created_at: string; last_active: string | null }>(
    `select ${USER_COLS}, to_json(created_at) #>> '{}' as created_at,
            to_json(greatest(
              (select max(last_used_at) from web_sessions w where w.user_id = u.id),
              (select max(created_at) from oauth_tokens o where o.user_id = u.id),
              (select max(last_used_at) from api_tokens a where a.user_id = u.id))) #>> '{}' as last_active
     from users u order by is_owner desc, lower(coalesce(name, email, '')), id`,
  );
  return rows.map(r => ({ ...toUser(r), createdAt: r.created_at, lastActiveAt: r.last_active }));
}

export async function updateProfile(q: Queryable, user: User, input: { name?: string | null; email?: string | null }): Promise<User> {
  const name = input.name !== undefined ? cleanName(input.name) : user.name;
  let email = user.email;
  if (input.email !== undefined) {
    email = cleanEmail(input.email);
    if (!email) throw new UserError('An email address is needed to sign in.');
    const taken = (await q.query('select 1 from users where lower(email) = $1 and id <> $2', [email, user.id])).rows[0];
    if (taken) throw new UserError('Someone else already signs in with that email.');
  }
  await q.query('update users set name = $2, email = $3 where id = $1', [user.id, name, email]);
  return { ...user, name, email };
}

export async function changePassword(q: Queryable, user: User, current: string, next: string): Promise<void> {
  if (user.isOwner) throw new UserError('Your password is the OWNER_PASSWORD secret; change it in GitHub and redeploy.');
  const row = (await q.query<UserRow>(`select ${USER_COLS} from users where id = $1`, [user.id])).rows[0];
  if (!row?.password_hash || !(await verifyPassword(current, row.password_hash))) throw new UserError('Your current password is wrong.');
  checkNewPassword(next);
  await q.query('update users set password_hash = $2 where id = $1', [user.id, await hashPassword(next)]);
}

/** Removes someone and everything in their notebook. The owner can't be removed. */
export async function removeUser(q: Queryable, id: number): Promise<string | null> {
  const row = (await q.query<{ name: string | null; email: string | null }>('delete from users where id = $1 and not is_owner returning name, email', [id]))
    .rows[0];
  return row ? (row.name ?? row.email ?? `user #${id}`) : null;
}

// ---------- invite and reset links ----------

export const INVITE_DAYS = 7;

export interface InviteRow {
  id: number;
  purpose: 'join' | 'reset';
  name: string | null;
  email: string | null;
  userId: number | null;
  createdAt: string;
  expiresAt: string;
}

const newToken = () => randomBytes(24).toString('base64url');

/** A one-time link to make an account (join) or set a new password (reset). Returns the token; only its hash is kept. */
export async function createInvite(
  q: Queryable,
  input: { createdBy: number; purpose: 'join' | 'reset'; userId?: number; name?: string | null; email?: string | null },
): Promise<{ token: string; invite: InviteRow }> {
  const token = newToken();
  const email = cleanEmail(input.email);
  if (input.purpose === 'join' && email) {
    const taken = (await q.query('select 1 from users where lower(email) = $1', [email])).rows[0];
    if (taken) throw new UserError('Someone already signs in with that email.');
  }
  if (input.purpose === 'reset') {
    // A new reset link replaces any earlier one for the same person.
    await q.query("delete from invites where purpose = 'reset' and user_id = $1 and used_at is null", [input.userId]);
  }
  const { rows } = await q.query<InviteDbRow>(
    `insert into invites (token_hash, purpose, created_by, user_id, name, email, expires_at)
     values ($1, $2, $3, $4, $5, $6, now() + make_interval(days => $7))
     returning ${INVITE_COLS}`,
    [sha256(token), input.purpose, input.createdBy, input.userId ?? null, cleanName(input.name), email, INVITE_DAYS],
  );
  return { token, invite: toInvite(rows[0]!) };
}

interface InviteDbRow {
  id: number;
  purpose: 'join' | 'reset';
  name: string | null;
  email: string | null;
  user_id: number | null;
  created_at: string;
  expires_at: string;
}
const INVITE_COLS = `id, purpose, name, email, user_id, to_json(created_at) #>> '{}' as created_at, to_json(expires_at) #>> '{}' as expires_at`;
const toInvite = (r: InviteDbRow): InviteRow => ({
  id: r.id,
  purpose: r.purpose,
  name: r.name,
  email: r.email,
  userId: r.user_id,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
});

/** Links not yet used or expired, newest first. */
export async function pendingInvites(q: Queryable): Promise<InviteRow[]> {
  const { rows } = await q.query<InviteDbRow>(
    `select ${INVITE_COLS} from invites where used_at is null and expires_at > now() order by id desc`,
  );
  return rows.map(toInvite);
}

export async function revokeInvite(q: Queryable, id: number): Promise<boolean> {
  return (await q.query('delete from invites where id = $1 and used_at is null returning id', [id])).rows.length > 0;
}

/** What a link is for, if it's still good. For a reset, the person's current details. */
export async function lookupInvite(q: Queryable, token: string): Promise<(InviteRow & { user: User | null }) | null> {
  if (!token || token.length > 100) return null;
  const row = (
    await q.query<InviteDbRow>(`select ${INVITE_COLS} from invites where token_hash = $1 and used_at is null and expires_at > now()`, [
      sha256(token),
    ])
  ).rows[0];
  if (!row) return null;
  const invite = toInvite(row);
  return { ...invite, user: invite.userId ? await getUser(q, invite.userId) : null };
}

/**
 * Uses a link: a join link makes the account; a reset link sets the person's password. Returns the user
 * to sign in. Runs in the caller's transaction, so a link can only be used once.
 */
export async function acceptInvite(
  q: Queryable,
  token: string,
  input: { name?: string | null; email?: string | null; password: string },
): Promise<User> {
  const row = (
    await q.query<InviteDbRow>(
      `select ${INVITE_COLS} from invites where token_hash = $1 and used_at is null and expires_at > now() for update`,
      [sha256(token)],
    )
  ).rows[0];
  if (!row) throw new UserError('This link has expired or was already used. Ask for a new one.');
  checkNewPassword(input.password);
  const hash = await hashPassword(input.password);
  let user: User;
  if (row.purpose === 'reset') {
    const target = row.user_id ? await getUser(q, row.user_id) : null;
    if (!target || target.isOwner) throw new UserError('This link has expired. Ask for a new one.');
    await q.query('update users set password_hash = $2 where id = $1', [target.id, hash]);
    // Everywhere they were signed in with the old password signs out.
    await q.query('delete from web_sessions where user_id = $1', [target.id]);
    user = target;
  } else {
    const email = cleanEmail(input.email);
    if (!email) throw new UserError('An email address is needed to sign in.');
    const taken = (await q.query('select 1 from users where lower(email) = $1', [email])).rows[0];
    if (taken) throw new UserError('Someone already signs in with that email.');
    const created = (
      await q.query<UserRow>(`insert into users (email, name, password_hash) values ($1, $2, $3) returning ${USER_COLS}`, [
        email,
        cleanName(input.name),
        hash,
      ])
    ).rows[0]!;
    user = toUser(created);
  }
  await q.query('update invites set used_at = now(), used_by = $2 where id = $1', [row.id, user.id]);
  return user;
}

// ---------- Siri Shortcut tokens ----------

export interface ApiTokenRow {
  id: number;
  label: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

export async function listApiTokens(q: Queryable, userId: number): Promise<ApiTokenRow[]> {
  const { rows } = await q.query<{ id: number; label: string | null; created_at: string; last_used_at: string | null }>(
    `select id, label, to_json(created_at) #>> '{}' as created_at, to_json(last_used_at) #>> '{}' as last_used_at
     from api_tokens where user_id = $1 order by id desc`,
    [userId],
  );
  return rows.map(r => ({ id: r.id, label: r.label, createdAt: r.created_at, lastUsedAt: r.last_used_at }));
}

export async function createApiToken(q: Queryable, userId: number, label: string | null): Promise<{ token: string; row: ApiTokenRow }> {
  const count = (await q.query<{ c: number }>('select count(*)::int as c from api_tokens where user_id = $1', [userId])).rows[0]!.c;
  if (count >= 10) throw new UserError('That’s 10 tokens already. Remove one you no longer use first.');
  const token = `bjj_${randomBytes(30).toString('base64url')}`;
  const { rows } = await q.query<{ id: number; created_at: string }>(
    `insert into api_tokens (user_id, token_hash, label) values ($1, $2, $3) returning id, to_json(created_at) #>> '{}' as created_at`,
    [userId, sha256(token), cleanName(label)],
  );
  return { token, row: { id: rows[0]!.id, label: cleanName(label), createdAt: rows[0]!.created_at, lastUsedAt: null } };
}

export async function revokeApiToken(q: Queryable, userId: number, id: number): Promise<boolean> {
  return (await q.query('delete from api_tokens where id = $1 and user_id = $2 returning id', [id, userId])).rows.length > 0;
}

/** Whose bearer token this is: the owner's API_TOKEN, or a token someone made in the app. */
export async function userForApiToken(q: Queryable, token: string, ownerApiToken: string): Promise<number | null> {
  if (!token) return null;
  if (secretsMatch(token, ownerApiToken)) return (await getOwner(q)).id;
  const { rows } = await q.query<{ user_id: number }>(
    'update api_tokens set last_used_at = now() where token_hash = $1 returning user_id',
    [sha256(token)],
  );
  return rows[0]?.user_id ?? null;
}
