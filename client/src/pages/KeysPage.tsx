import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PageHeader } from '@/components/page-header';
import type { ApiKey, Platform } from '../../../shared/types';

const PLATFORMS: { value: Platform; label: string }[] = [
  { value: 'google', label: 'Google AI Studio' },
  { value: 'groq', label: 'Groq' },
  { value: 'cerebras', label: 'Cerebras' },
  { value: 'sambanova', label: 'SambaNova' },
  { value: 'nvidia', label: 'NVIDIA NIM' },
  { value: 'mistral', label: 'Mistral' },
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'github', label: 'GitHub Models' },
  { value: 'cohere', label: 'Cohere' },
  { value: 'cloudflare', label: 'Cloudflare Workers AI' },
  { value: 'zhipu', label: 'Zhipu AI (Z.ai)' },
  { value: 'ollama', label: 'Ollama Cloud' },
  { value: 'kilo', label: 'Kilo Gateway (anon ok)' },
  { value: 'pollinations', label: 'Pollinations (anon ok)' },
  { value: 'llm7', label: 'LLM7 (anon ok)' },
];

const statusDot: Record<string, string> = {
  healthy: 'bg-emerald-500',
  rate_limited: 'bg-amber-500',
  invalid: 'bg-rose-500',
  error: 'bg-rose-500',
  unknown: 'bg-muted-foreground/40',
};

const statusLabel: Record<string, string> = {
  healthy: 'healthy',
  rate_limited: 'rate-limited',
  invalid: 'invalid',
  error: 'error',
  unknown: 'unchecked',
};

interface HealthPlatform {
  platform: string;
  totalKeys: number;
  healthyKeys: number;
  rateLimitedKeys: number;
  invalidKeys: number;
  errorKeys: number;
  unknownKeys: number;
}

interface HealthData {
  platforms: HealthPlatform[];
  keys: { id: number; platform: string; status: string; lastCheckedAt: string | null }[];
}

function UnifiedKeySection() {
  const queryClient = useQueryClient();
  const [showKey, setShowKey] = useState(false);
  const [copied, setCopied] = useState(false);

  const { data } = useQuery<{ apiKey: string }>({
    queryKey: ['unified-key'],
    queryFn: () => apiFetch('/api/settings/api-key'),
  });

  const regenerate = useMutation({
    mutationFn: () => apiFetch('/api/settings/api-key/regenerate', { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['unified-key'] }),
  });

  const apiKey = data?.apiKey ?? '';
  const masked = apiKey ? apiKey.slice(0, 13) + '•'.repeat(32) : '…';
  const baseUrl = import.meta.env.DEV
    ? `http://${window.location.hostname}:${__SERVER_PORT__}/v1`
    : `${window.location.origin}/v1`;

  function copy() {
    navigator.clipboard.writeText(apiKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <section className="rounded-lg border bg-card p-5">
      <div className="flex items-start justify-between gap-4 mb-3">
        <div>
          <h2 className="text-sm font-medium">Your unified API key</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Use this as your OpenAI <code className="font-mono">api_key</code>; it authenticates requests to this proxy.
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => regenerate.mutate()}
          disabled={regenerate.isPending}
        >
          Regenerate
        </Button>
      </div>

      <div className="flex items-center gap-2">
        <code className="flex-1 font-mono text-xs bg-muted px-3 py-2 rounded-md select-all truncate tabular-nums">
          {showKey ? apiKey : masked}
        </code>
        <Button variant="outline" size="sm" onClick={() => setShowKey(!showKey)}>
          {showKey ? 'Hide' : 'Show'}
        </Button>
        <Button variant="outline" size="sm" onClick={copy} className="ml-2">
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>

      <div className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
        <span className="text-muted-foreground">Base URL</span>
        <code className="font-mono">{baseUrl}</code>
        <span className="text-muted-foreground">Endpoint</span>
        <code className="font-mono">/v1/chat/completions</code>
      </div>
    </section>
  );
}

export default function KeysPage() {
  const queryClient = useQueryClient();
  const [platform, setPlatform] = useState<Platform | ''>('');
  const [apiKey, setApiKey] = useState('');
  const [accountId, setAccountId] = useState('');
  const [label, setLabel] = useState('');
  const [saveMessage, setSaveMessage] = useState('');
  const [loadMessage, setLoadMessage] = useState('');
  const needsAccountId = platform === 'cloudflare';

  const { data: keys = [], isLoading } = useQuery<ApiKey[]>({
    queryKey: ['keys'],
    queryFn: () => apiFetch('/api/keys'),
  });

  const { data: healthData } = useQuery<HealthData>({
    queryKey: ['health'],
    queryFn: () => apiFetch('/api/health'),
    refetchInterval: 30000,
  });

  const addKey = useMutation({
    mutationFn: (body: { platform: string; key: string; label?: string }) =>
      apiFetch('/api/keys', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['keys'] });
      queryClient.invalidateQueries({ queryKey: ['health'] });
      queryClient.invalidateQueries({ queryKey: ['fallback'] });
      setPlatform('');
      setApiKey('');
      setAccountId('');
      setLabel('');
    },
  });

  const deleteKey = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/keys/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['keys'] });
      queryClient.invalidateQueries({ queryKey: ['health'] });
    },
  });

  const checkAll = useMutation({
    mutationFn: () => apiFetch('/api/health/check-all', { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['health'] });
      queryClient.invalidateQueries({ queryKey: ['keys'] });
    },
  });

  const clearAllKeys = useMutation({
    mutationFn: () => apiFetch('/api/keys', { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['keys'] });
      queryClient.invalidateQueries({ queryKey: ['health'] });
      queryClient.invalidateQueries({ queryKey: ['fallback'] });
    },
  });

  const removeNonWorking = useMutation({
    mutationFn: () => apiFetch('/api/keys/non-working', { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['keys'] });
      queryClient.invalidateQueries({ queryKey: ['health'] });
      queryClient.invalidateQueries({ queryKey: ['fallback'] });
    },
  });

  const checkKey = useMutation({
    mutationFn: (keyId: number) => apiFetch(`/api/health/check/${keyId}`, { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['health'] });
      queryClient.invalidateQueries({ queryKey: ['keys'] });
    },
  });

  function saveKeysToFile() {
    apiFetch<{ platform: string; key: string; label: string; status: string }[]>('/api/keys/export').then((exportedKeys) => {
      const dataStr = JSON.stringify(exportedKeys, null, 2);
      const blob = new Blob([dataStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const timestamp = new Date().toISOString().slice(0, 10);
      a.download = `keys-backup-${timestamp}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setSaveMessage(`Saved ${exportedKeys.length} keys`);
      setTimeout(() => setSaveMessage(''), 3000);
    }).catch(() => {
      setSaveMessage('Failed to export keys');
      setTimeout(() => setSaveMessage(''), 3000);
    });
  }

  function loadKeysFromFile() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = (e: Event) => {
      const target = e.target as HTMLInputElement;
      if (!target.files?.[0]) return;
      const file = target.files[0];
      const reader = new FileReader();
      reader.onload = (loadEvent) => {
        try {
          const parsed = JSON.parse(loadEvent.target?.result as string);
          if (!Array.isArray(parsed)) {
            setLoadMessage('Invalid file format');
            return;
          }
          let addedCount = 0;
          parsed.forEach((keyData: { platform: string; key: string; label?: string }) => {
            if (keyData.platform && keyData.key) {
              apiFetch('/api/keys', {
                method: 'POST',
                body: JSON.stringify({
                  platform: keyData.platform,
                  key: keyData.key,
                  label: keyData.label,
                }),
              });
              addedCount++;
            }
          });
          queryClient.invalidateQueries({ queryKey: ['keys'] });
          queryClient.invalidateQueries({ queryKey: ['health'] });
          setLoadMessage(`Loaded ${addedCount} keys`);
        } catch {
          setLoadMessage('Failed to parse file');
        }
        setTimeout(() => setLoadMessage(''), 3000);
      };
      reader.readAsText(file);
    };
    input.click();
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!platform || !apiKey) return;
    if (needsAccountId && !accountId) return;
    const key = needsAccountId ? `${accountId}:${apiKey}` : apiKey;
    addKey.mutate({ platform, key, label: label || undefined });
  };

  const healthKeyMap = new Map<number, { status: string; lastCheckedAt: string | null }>();
  for (const k of healthData?.keys ?? []) healthKeyMap.set(k.id, k);

  const grouped = PLATFORMS.map(p => ({
    ...p,
    keys: keys.filter(k => k.platform === p.value),
  })).filter(p => p.keys.length > 0);

  return (
    <div>
      <PageHeader
        title="Keys"
        description="Provider credentials and the unified API key your apps connect with."
        actions={
          <div className="flex gap-2">
            {keys.length > 0 && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => checkAll.mutate()}
                  disabled={checkAll.isPending}
                >
                  {checkAll.isPending ? 'Checking…' : 'Check all'}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => removeNonWorking.mutate()}
                  disabled={removeNonWorking.isPending}
                >
                  {removeNonWorking.isPending ? 'Removing…' : 'Remove non-working'}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    if (window.confirm('Remove all keys? This cannot be undone.')) {
                      clearAllKeys.mutate();
                    }
                  }}
                  disabled={clearAllKeys.isPending}
                >
                  {clearAllKeys.isPending ? 'Clearing…' : 'Clear all'}
                </Button>
              </>
            )}
            <Button variant="outline" size="sm" onClick={saveKeysToFile}>
              Save Keys
            </Button>
            <Button variant="outline" size="sm" onClick={loadKeysFromFile}>
              Load Keys
            </Button>
          </div>
        }
      />

      <div className="space-y-8">
        <UnifiedKeySection />

        {saveMessage && (
          <div className="rounded-lg border border-emerald-500/50 bg-emerald-50 p-3 text-sm text-emerald-700">
            {saveMessage}
          </div>
        )}
        {loadMessage && (
          <div className="rounded-lg border border-blue-500/50 bg-blue-50 p-3 text-sm text-blue-700">
            {loadMessage}
          </div>
        )}

        <section>
          <h2 className="text-sm font-medium mb-3">Add a provider key</h2>
          <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-3 rounded-lg border p-4 bg-card">
            <div className="space-y-1.5">
              <Label className="text-xs">Platform</Label>
              <Select value={platform} onValueChange={(v) => setPlatform(v as Platform)}>
                <SelectTrigger className="w-[220px]">
                  <SelectValue placeholder="Select provider" />
                </SelectTrigger>
                <SelectContent>
                  {PLATFORMS.map(p => (
                    <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {needsAccountId && (
              <div className="space-y-1.5">
                <Label className="text-xs">Account ID</Label>
                <Input
                  value={accountId}
                  onChange={e => setAccountId(e.target.value)}
                  placeholder="a1b2c3d4…"
                  className="w-[200px] font-mono text-xs"
                />
              </div>
            )}

            <div className="space-y-1.5 flex-1 min-w-[240px]">
              <Label className="text-xs">{needsAccountId ? 'API token' : 'API key'}</Label>
              <Input
                type="password"
                value={apiKey}
                onChange={e => setApiKey(e.target.value)}
                placeholder={needsAccountId ? 'Bearer token' : 'paste key here'}
                className="font-mono text-xs"
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">Label</Label>
              <Input
                value={label}
                onChange={e => setLabel(e.target.value)}
                placeholder="optional"
                className="w-[160px]"
              />
            </div>

            <Button
              type="submit"
              size="sm"
              disabled={!platform || !apiKey || (needsAccountId && !accountId) || addKey.isPending}
            >
              {addKey.isPending ? 'Adding…' : 'Add key'}
            </Button>
          </form>

          {addKey.isError && (
            <p className="text-destructive text-xs mt-2">{(addKey.error as Error).message}</p>
          )}
        </section>

        <section>
          <h2 className="text-sm font-medium mb-3">Configured providers</h2>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : keys.length === 0 ? (
            <div className="rounded-lg border border-dashed p-8 text-center">
              <p className="text-sm text-muted-foreground">
                No provider keys yet. Add one above to start routing.
              </p>
            </div>
          ) : (
            <div className="space-y-6">
              {grouped.map(group => (
                <div key={group.value}>
                  <div className="flex items-baseline justify-between mb-2">
                    <h3 className="text-sm font-medium">{group.label}</h3>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {group.keys.length} key{group.keys.length === 1 ? '' : 's'}
                    </span>
                  </div>

                  <div className="rounded-lg border divide-y bg-card overflow-hidden">
                    {group.keys.map(k => {
                      const h = healthKeyMap.get(k.id);
                      const status = h?.status ?? k.status;
                      const lastChecked = h?.lastCheckedAt;
                      const isFailed = status === 'invalid' || status === 'error';
                      return (
                        <div
                          key={k.id}
                          className={`flex items-center gap-3 px-4 py-3 hover:bg-muted/40 transition-colors ${
                            isFailed ? 'bg-rose-50' : ''
                          }`}
                        >
                          <span className={`size-1.5 rounded-full flex-shrink-0 ${statusDot[status] ?? statusDot.unknown}`} />
                          <code className="text-xs font-mono flex-shrink-0">{k.maskedKey}</code>
                          {k.label && <span className="text-xs text-muted-foreground">{k.label}</span>}
                          <span className="text-xs text-muted-foreground">{statusLabel[status] ?? status}</span>
                          <div className="flex-1" />
                          {lastChecked && (
                            <span className="text-[11px] text-muted-foreground tabular-nums">
                              {new Date(lastChecked).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                            </span>
                          )}
                          <Button
                            variant="ghost"
                            size="xs"
                            onClick={() => checkKey.mutate(k.id)}
                            disabled={checkKey.isPending}
                          >
                            Test
                          </Button>
                          <Button
                            variant="ghost"
                            size="xs"
                            className="text-muted-foreground hover:text-destructive"
                            onClick={() => deleteKey.mutate(k.id)}
                            disabled={deleteKey.isPending}
                          >
                            Remove
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
