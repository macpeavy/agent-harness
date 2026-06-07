// Read a required env var; throws if absent or empty.
// Use at module level to fail fast on missing configuration.
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}
