interface RuntimeStartupClient {
  start(): Promise<unknown>;
  restoreCredential(providerId: string, credential: string): Promise<void>;
  logout?(providerId: string): Promise<void>;
}

export function createNativeRuntimeStartup(
  runtime: RuntimeStartupClient,
  credentials: () => Readonly<Record<string, string>>,
  onRestoreError: (providerId: string, error: unknown) => void,
) {
  let state: { ready: boolean; error?: string } = { ready: false };
  let pending: Promise<void> | null = null;

  const prepare = async (): Promise<void> => {
    if (pending) return pending;
    if (state.ready) return;
    pending = (async () => {
      try {
        await runtime.start();
        for (const [providerId, credential] of Object.entries(credentials())) {
          try { await runtime.restoreCredential(providerId, credential); }
          catch (error) {
            try { await runtime.logout?.(providerId); } catch { /* the rejected credential remains unusable */ }
            onRestoreError(providerId, error);
          }
        }
        state = { ready: true };
      } catch (error) {
        state = { ready: false, error: error instanceof Error ? error.message : "Native runtime failed to start" };
        throw error;
      }
    })();
    try { await pending; }
    finally { pending = null; }
  };

  return { status: () => state, prepare };
}
