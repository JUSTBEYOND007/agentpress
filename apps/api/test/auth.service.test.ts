import type { AgentPressDatabase } from '@agentpress/database';
import { UnauthorizedException } from '@nestjs/common';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';

import { AuthService } from '../src/auth/auth.service.js';

describe('AuthService', () => {
  let auth: AuthService;
  let privateKey: CryptoKey;

  beforeAll(async () => {
    const keyPair = await generateKeyPair('RS256', { extractable: true });
    privateKey = keyPair.privateKey;
    const publicJwk = await exportJWK(keyPair.publicKey);
    auth = new AuthService(
      existingUserDatabase(),
      'https://identity.example.com',
      'https://api.example.com',
      createLocalJWKSet({ keys: [{ ...publicJwk, kid: 'test-key', alg: 'RS256', use: 'sig' }] }),
    );
  });

  it('verifies signature, issuer and audience before resolving the local user', async () => {
    const token = await tokenFor(privateKey, 'https://api.example.com');
    await expect(auth.authenticate(`Bearer ${token}`)).resolves.toEqual({
      id: '00000000-0000-4000-8000-000000000001',
      subject: 'logto|authenticated',
      displayName: 'Authenticated User',
    });
  });

  it('rejects missing credentials and a token for another audience', async () => {
    await expect(auth.authenticate(undefined)).rejects.toBeInstanceOf(UnauthorizedException);
    const token = await tokenFor(privateKey, 'https://other.example.com');
    await expect(auth.authenticate(`Bearer ${token}`)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});

function tokenFor(privateKey: CryptoKey, audience: string): Promise<string> {
  return new SignJWT({ name: 'Authenticated User' })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setSubject('logto|authenticated')
    .setIssuer('https://identity.example.com/oidc')
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}

function existingUserDatabase(): AgentPressDatabase {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () =>
            Promise.resolve([
              {
                id: '00000000-0000-4000-8000-000000000001',
                displayName: 'Authenticated User',
              },
            ]),
        }),
      }),
    }),
  } as unknown as AgentPressDatabase;
}
