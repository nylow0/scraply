export async function revokeNativeAccount<T>(
  removePersistedCredential: () => void | Promise<void>,
  revokeRuntimeAccount: () => Promise<T>,
): Promise<T> {
  let persistenceError: unknown;
  try { await removePersistedCredential(); }
  catch (error) { persistenceError = error; }

  let revocation: { ok: true; value: T } | { ok: false; error: unknown };
  try { revocation = { ok: true, value: await revokeRuntimeAccount() }; }
  catch (error) { revocation = { ok: false, error }; }

  if (persistenceError) throw persistenceError;
  if (!revocation.ok) throw revocation.error;
  return revocation.value;
}
