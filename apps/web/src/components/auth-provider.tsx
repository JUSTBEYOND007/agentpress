'use client';

import { LogtoProvider, useHandleSignInCallback, useLogto, type LogtoConfig } from '@logto/react';
import { LogIn } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { bindAccessTokenProvider } from '../lib/authenticated-fetch';

const endpoint = process.env.NEXT_PUBLIC_LOGTO_ENDPOINT;
const appId = process.env.NEXT_PUBLIC_LOGTO_APP_ID;
const resource = process.env.NEXT_PUBLIC_LOGTO_API_RESOURCE ?? 'http://localhost:4000/api';
const logtoConfig: LogtoConfig | undefined =
  endpoint && appId ? { endpoint, appId, resources: [resource] } : undefined;

export function AuthProvider({ children }: { readonly children: ReactNode }): React.JSX.Element {
  if (!logtoConfig) {
    return (
      <main className="auth-screen">
        <div className="auth-panel">
          <h1>AgentPress</h1>
          <p>身份服务尚未配置。</p>
          <code>NEXT_PUBLIC_LOGTO_ENDPOINT / NEXT_PUBLIC_LOGTO_APP_ID</code>
        </div>
      </main>
    );
  }
  return (
    <LogtoProvider config={logtoConfig}>
      <AuthGate>{children}</AuthGate>
    </LogtoProvider>
  );
}

function AuthGate({ children }: { readonly children: ReactNode }): React.JSX.Element {
  useHandleSignInCallback(() => {
    window.history.replaceState({}, '', '/');
  });
  // The React SDK marks the overloaded member deprecated even when the object form is used below.
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  const { isAuthenticated, isLoading, error, signIn, signOut, getAccessToken } = useLogto();
  const [tokenProviderReady, setTokenProviderReady] = useState(false);
  const getAccessTokenRef = useRef(getAccessToken);
  getAccessTokenRef.current = getAccessToken;

  useEffect(() => {
    bindAccessTokenProvider(
      isAuthenticated ? () => getAccessTokenRef.current(resource) : undefined,
    );
    setTokenProviderReady(isAuthenticated);
    return () => {
      bindAccessTokenProvider(undefined);
      setTokenProviderReady(false);
    };
  }, [isAuthenticated]);

  if (isLoading && !tokenProviderReady) return <main className="auth-screen">正在验证身份...</main>;
  if (error) return <main className="auth-screen">身份验证失败：{error.message}</main>;
  if (!isAuthenticated) {
    return (
      <main className="auth-screen">
        <div className="auth-panel">
          <h1>AgentPress</h1>
          <p>登录后进入你的写作工作区。</p>
          <button type="button" onClick={() => void signIn({ redirectUri: rootUrl() })}>
            <LogIn aria-hidden="true" size={16} /> 登录
          </button>
        </div>
      </main>
    );
  }
  if (!tokenProviderReady) return <main className="auth-screen">正在建立安全会话...</main>;
  return (
    <>
      {children}
      <button
        className="auth-sign-out"
        type="button"
        title="退出登录"
        onClick={() => void signOut(rootUrl())}
      >
        退出
      </button>
    </>
  );
}

function rootUrl(): string {
  return new URL('/', window.location.origin).toString();
}
