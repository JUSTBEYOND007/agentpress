import { randomUUID } from 'node:crypto';

import { appUsers, type AgentPressDatabase } from '@agentpress/database';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

export type AuthenticatedUser = {
  readonly id: string;
  readonly subject: string;
  readonly displayName: string;
};

@Injectable()
export class AuthService {
  private readonly issuer: string;
  private readonly jwks: JWTVerifyGetKey;

  public constructor(
    private readonly database: AgentPressDatabase,
    logtoEndpoint: string,
    private readonly audience: string,
    jwks?: JWTVerifyGetKey,
  ) {
    this.issuer = `${logtoEndpoint.replace(/\/$/u, '')}/oidc`;
    this.jwks = jwks ?? createRemoteJWKSet(new URL(`${this.issuer}/jwks`));
  }

  public async authenticate(authorization: string | undefined): Promise<AuthenticatedUser> {
    const token = bearerToken(authorization);
    if (!token) throw new UnauthorizedException('A Bearer access token is required');
    try {
      const { payload } = await jwtVerify(token, this.jwks, {
        issuer: this.issuer,
        audience: this.audience,
      });
      if (!payload.sub) throw new UnauthorizedException('Access token has no subject');
      return await this.resolveUser(payload.sub, displayName(payload));
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      throw new UnauthorizedException('Access token is invalid or expired', { cause: error });
    }
  }

  private async resolveUser(subject: string, name: string): Promise<AuthenticatedUser> {
    const existing = await this.database
      .select({ id: appUsers.id, displayName: appUsers.displayName })
      .from(appUsers)
      .where(eq(appUsers.logtoSubject, subject))
      .limit(1);
    const user = existing[0];
    if (user) return { id: user.id, subject, displayName: user.displayName };
    const inserted = await this.database
      .insert(appUsers)
      .values({ id: randomUUID(), logtoSubject: subject, displayName: name })
      .onConflictDoNothing({ target: appUsers.logtoSubject })
      .returning({ id: appUsers.id, displayName: appUsers.displayName });
    const created = inserted[0];
    if (created) return { id: created.id, subject, displayName: created.displayName };
    const raced = await this.database
      .select({ id: appUsers.id, displayName: appUsers.displayName })
      .from(appUsers)
      .where(eq(appUsers.logtoSubject, subject))
      .limit(1);
    if (!raced[0]) throw new UnauthorizedException('Unable to resolve authenticated user');
    return { id: raced[0].id, subject, displayName: raced[0].displayName };
  }
}

function bearerToken(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = /^Bearer\s+([^\s]+)$/iu.exec(value);
  return match?.[1];
}

function displayName(payload: Record<string, unknown>): string {
  for (const key of ['name', 'username', 'email']) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 160);
  }
  return 'AgentPress User';
}
