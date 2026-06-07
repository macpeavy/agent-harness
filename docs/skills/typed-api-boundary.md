---
name: typed-api-boundary
description: Use when calling a foreign JSON API (the OpenCode server, GitHub, any HTTP endpoint) from the substrate. The pattern for turning untyped responses into safe local types without `any`.
---

# Typed API boundary

**When:** you're adding a call to an external HTTP/JSON API whose response you don't
control — most often the OpenCode server (`opencode/client.ts`), but the same rule
holds for any foreign JSON.

**Files:** the client/wrapper module for that API (e.g. `src/opencode/client.ts`). Keep
the casting and defaulting *inside* the client; callers receive a clean local type.

## How

1. **Wrap fetch with a shared helper that fails loud.** Non-2xx → throw with method,
   path, status, and body text. Never return a non-ok response as data.
2. **Cast the parsed JSON to a local shape with optional fields** (`as { id?: string }`),
   never `any`. You are describing what you *expect*, defensively.
3. **Default every field you read** (`info.tokens?.input ?? 0`, `?? "?"`). A missing or
   renamed upstream field must not throw three calls downstream.
4. **Return a clean, fully-typed local interface** to callers — the messiness stays in
   the client.
5. **Validate the fields you actually depend on** and throw if absent
   (`if (!s?.id) throw ...`).

## Worked example

From `src/opencode/client.ts` — the shared `post` and a typed `createSession`:

```ts
private async post(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${this.baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} → ${res.status} ${await res.text()}`);
  return res.json();
}

async createSession(opts: CreateSessionOpts = {}): Promise<string> {
  const s = (await this.post("/session", opts)) as { id?: string };
  if (!s?.id) throw new Error(`createSession: no id in response (${JSON.stringify(s)})`);
  return s.id;        // caller gets a clean `string`, never the raw JSON
}
```

The caller never sees `unknown`, never sees `any`, and a malformed response throws a
diagnosable error rather than corrupting state.
