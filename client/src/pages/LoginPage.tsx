import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const STORAGE_KEY = 'freellmapi_auth_key';

function getStoredKey(): string | null {
  return sessionStorage.getItem(STORAGE_KEY);
}

export function useAuthKey(): [string | null, (key: string) => void, () => void] {
  const [key, setKeyState] = useState<string | null>(getStoredKey());

  const setKey = (newKey: string) => {
    sessionStorage.setItem(STORAGE_KEY, newKey);
    setKeyState(newKey);
  };

  const clearKey = () => {
    sessionStorage.removeItem(STORAGE_KEY);
    setKeyState(null);
  };

  return [key, setKey, clearKey];
}

export { getStoredKey };

export default function LoginPage() {
  const navigate = useNavigate();
  const [key, setKey] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (getStoredKey()) {
      navigate('/playground', { replace: true });
    }
  }, [navigate]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const res = await fetch('/api/ping', {
        headers: { 'Authorization': `Bearer ${key.trim()}` },
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error?.message ?? 'Invalid API key');
        setLoading(false);
        return;
      }

      sessionStorage.setItem(STORAGE_KEY, key.trim());
      navigate('/playground', { replace: true });
    } catch {
      setError('Connection failed. Check the URL and try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center space-y-2">
          <div className="flex items-center justify-center gap-2 mb-4">
            <span className="inline-block size-2 rounded-full bg-foreground" />
            <span className="font-semibold tracking-tight text-lg">FreeLLMAPI</span>
          </div>
          <h1 className="text-xl font-semibold tracking-tight">Enter your API key</h1>
          <p className="text-sm text-muted-foreground">
            This key authenticates you to the dashboard and proxy.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="api-key">Unified API Key</Label>
            <Input
              id="api-key"
              type="password"
              value={key}
              onChange={e => setKey(e.target.value)}
              placeholder="freellmapi-..."
              className="font-mono text-sm"
              autoFocus
              autoComplete="off"
            />
          </div>

          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}

          <Button type="submit" className="w-full" disabled={loading || !key.trim()}>
            {loading ? 'Verifying…' : 'Sign in'}
          </Button>
        </form>

        <p className="text-xs text-muted-foreground text-center">
          Your key is stored in session storage and cleared when you close the tab.
        </p>
      </div>
    </div>
  );
}
