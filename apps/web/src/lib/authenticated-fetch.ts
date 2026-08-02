type AccessTokenProvider = () => Promise<string | undefined>;

let accessTokenProvider: AccessTokenProvider | undefined;

export function bindAccessTokenProvider(provider: AccessTokenProvider | undefined): void {
  accessTokenProvider = provider;
}

export async function authenticatedFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const token = await accessTokenProvider?.();
  if (!token) throw new Error('Authenticated API request requires a Logto access token');
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${token}`);
  return fetch(input, { ...init, headers });
}
