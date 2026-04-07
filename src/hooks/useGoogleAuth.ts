import { useState, useEffect } from 'react';

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string;
const SCOPE = 'https://www.googleapis.com/auth/fitness.heart_rate.read';

export function useGoogleAuth() {
  const [accessToken, setAccessToken] = useState<string | null>(null);

  useEffect(() => {
    // OAuth 리디렉션 후 URL 해시에서 access_token 파싱
    const hash = window.location.hash;
    if (hash) {
      const params = new URLSearchParams(hash.substring(1));
      const token = params.get('access_token');
      if (token) {
        setAccessToken(token);
        localStorage.setItem('ha_google_token', token);
        // URL 정리 (토큰이 주소창에 노출되지 않도록)
        window.history.replaceState(null, '', window.location.pathname);
      }
    } else {
      // 이전에 저장된 토큰 복원
      const stored = localStorage.getItem('ha_google_token');
      if (stored) {
        setAccessToken(stored);
      }
    }
  }, []);

  const login = () => {
    const redirectUri = window.location.origin;
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: 'token',
      scope: SCOPE,
      include_granted_scopes: 'true',
    });
    window.location.href = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  };

  const logout = () => {
    setAccessToken(null);
    localStorage.removeItem('ha_google_token');
  };

  return { accessToken, login, logout };
}
