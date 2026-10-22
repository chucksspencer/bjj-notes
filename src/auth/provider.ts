import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Response } from 'express';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import { InvalidGrantError, InvalidTargetError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { Db } from '../db.js';
import { loginPage } from './login.js';

const ACCESS_TTL_S = 60 * 60; // 1 hour
const REFRESH_TTL_S = 90 * 24 * 60 * 60; // 90 days
const CODE_TTL_S = 10 * 60;

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const newSecret = () => randomBytes(32).toString('base64url');

/** Constant-time comparison of two secrets of any length. */
export function secretsMatch(given: string, expected: string): boolean {
  const a = Buffer.from(sha256(given));
  const b = Buffer.from(sha256(expected));
  return timingSafeEqual(a, b);
}

const sameResource = (a: string, b: string) => a.replace(/#.*$/, '').replace(/\/$/, '') === b.replace(/#.*$/, '').replace(/\/$/, '');

class DbClientsStore implements OAuthRegisteredClientsStore {
  constructor(private db: Db) {}

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    const { rows } = await this.db.query<{ info: OAuthClientInformationFull | string }>(
      'select info from oauth_clients where client_id = $1',
      [clientId],
    );
    const info = rows[0]?.info;
    return typeof info === 'string' ? JSON.parse(info) : info;
  }

  async registerClient(client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>) {
    // The SDK has already generated client_id; it is on the object even though the type omits it.
    const full = client as OAuthClientInformationFull;
    await this.db.query('insert into oauth_clients (client_id, info) values ($1, $2)', [full.client_id, JSON.stringify(full)]);
    return full;
  }
}

/**
 * OAuth 2.1 authorization server for the Claude connector: dynamic client registration, PKCE (checked
 * by the SDK), an email and password sign-in page, rotating refresh tokens. Codes and tokens belong to
 * the person who signed in; only their hashes are stored.
 */
export class NotesOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: DbClientsStore;

  constructor(
    private db: Db,
    /** The MCP endpoint URL; tokens are bound to it (RFC 8707). */
    readonly resourceUrl: URL,
  ) {
    this.clientsStore = new DbClientsStore(db);
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    if (params.resource && !sameResource(params.resource.href, this.resourceUrl.href)) {
      const url = new URL(params.redirectUri);
      url.searchParams.set('error', 'invalid_target');
      if (params.state) url.searchParams.set('state', params.state);
      res.redirect(302, url.href);
      return;
    }
    res.status(200).type('html').set(loginHeaders(params.redirectUri)).send(
      loginPage({
        clientName: client.client_name ?? 'An app',
        fields: {
          client_id: client.client_id,
          redirect_uri: params.redirectUri,
          state: params.state ?? '',
          code_challenge: params.codeChallenge,
          scope: (params.scopes ?? []).join(' '),
          resource: params.resource?.href ?? '',
        },
      }),
    );
  }

  /** Called by the login form handler once the email and password check out. */
  async issueCode(input: {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    scopes: string[];
    resource: string | null;
    userId: number;
  }): Promise<string> {
    const code = newSecret();
    await this.db.query(
      `insert into oauth_codes (code_hash, client_id, redirect_uri, code_challenge, scopes, resource, expires_at, user_id)
       values ($1, $2, $3, $4, $5, $6, now() + make_interval(secs => $7), $8)`,
      [sha256(code), input.clientId, input.redirectUri, input.codeChallenge, input.scopes, input.resource, CODE_TTL_S, input.userId],
    );
    return code;
  }

  private async findCode(client: OAuthClientInformationFull, code: string) {
    const { rows } = await this.db.query<{
      client_id: string;
      redirect_uri: string;
      code_challenge: string;
      scopes: string[];
      resource: string | null;
      expired: boolean;
      used: boolean;
      user_id: number;
    }>(
      `select client_id, redirect_uri, code_challenge, scopes, resource, used, expires_at < now() as expired, user_id
       from oauth_codes where code_hash = $1`,
      [sha256(code)],
    );
    const row = rows[0];
    if (!row || row.client_id !== client.client_id) throw new InvalidGrantError('Invalid authorization code');
    return row;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    return (await this.findCode(client, code)).code_challenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const row = await this.findCode(client, code);
    if (row.used || row.expired) throw new InvalidGrantError('Authorization code expired or already used');
    if (redirectUri && redirectUri !== row.redirect_uri) throw new InvalidGrantError('redirect_uri mismatch');
    if (resource && !sameResource(resource.href, this.resourceUrl.href)) throw new InvalidTargetError('Unknown resource');
    const { rows } = await this.db.query<{ code_hash: string }>(
      'update oauth_codes set used = true where code_hash = $1 and not used returning code_hash',
      [sha256(code)],
    );
    if (!rows.length) throw new InvalidGrantError('Authorization code already used');
    return this.issueTokens(client.client_id, row.scopes, row.user_id);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    if (resource && !sameResource(resource.href, this.resourceUrl.href)) throw new InvalidTargetError('Unknown resource');
    // Rotate: the presented refresh token is revoked atomically and a new pair is issued.
    const { rows } = await this.db.query<{ scopes: string[]; user_id: number }>(
      `update oauth_tokens set revoked = true
       where token_hash = $1 and kind = 'refresh' and client_id = $2 and not revoked and expires_at > now()
       returning scopes, user_id`,
      [sha256(refreshToken), client.client_id],
    );
    const row = rows[0];
    if (!row) throw new InvalidGrantError('Invalid refresh token');
    const granted = scopes?.length ? scopes.filter(s => row.scopes.includes(s)) : row.scopes;
    return this.issueTokens(client.client_id, granted, row.user_id);
  }

  private async issueTokens(clientId: string, scopes: string[], userId: number): Promise<OAuthTokens> {
    const access = newSecret();
    const refresh = newSecret();
    const insert = `insert into oauth_tokens (token_hash, kind, client_id, scopes, resource, expires_at, user_id)
                    values ($1, $2, $3, $4, $5, now() + make_interval(secs => $6), $7)`;
    await this.db.query(insert, [sha256(access), 'access', clientId, scopes, this.resourceUrl.href, ACCESS_TTL_S, userId]);
    await this.db.query(insert, [sha256(refresh), 'refresh', clientId, scopes, this.resourceUrl.href, REFRESH_TTL_S, userId]);
    return {
      access_token: access,
      token_type: 'bearer',
      expires_in: ACCESS_TTL_S,
      refresh_token: refresh,
      scope: scopes.join(' ') || undefined,
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const { rows } = await this.db.query<{ client_id: string; scopes: string[]; resource: string | null; exp: number; user_id: number }>(
      `select client_id, scopes, resource, extract(epoch from expires_at)::bigint as exp, user_id
       from oauth_tokens where token_hash = $1 and kind = 'access' and not revoked and expires_at > now()`,
      [sha256(token)],
    );
    const row = rows[0];
    if (!row) throw new InvalidTokenError('Invalid or expired access token');
    return {
      token,
      clientId: row.client_id,
      scopes: row.scopes,
      expiresAt: Number(row.exp),
      resource: row.resource ? new URL(row.resource) : undefined,
      extra: { userId: Number(row.user_id) },
    };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    await this.db.query('update oauth_tokens set revoked = true where token_hash = $1 and client_id = $2', [
      sha256(request.token),
      client.client_id,
    ]);
  }
}

/**
 * Headers for the login page. form-action must also allow the client's redirect origin,
 * because browsers apply it to the redirect that follows the form post.
 */
export function loginHeaders(redirectUri: string): Record<string, string> {
  let origin = '';
  try {
    origin = new URL(redirectUri).origin;
  } catch {
    // leave it out; the SDK has already validated redirect_uri
  }
  return {
    'Cache-Control': 'no-store',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${origin}; frame-ancestors 'none'`,
    'Referrer-Policy': 'no-referrer',
  };
}
