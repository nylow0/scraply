import { expect, test } from "bun:test";
import { ValidationStateSchema, type ValidationState } from "../../src/shared/ipc";
import { isSearchProviderChecking, isSearchProviderReady } from "../../src/shared/search-provider-status";

test.each<{ name: string; status: ValidationState["exa"]; ready: boolean; checking: boolean }>([
  { name: "verified key", status: { valid: true, configured: true, checked: true }, ready: true, checking: false },
  { name: "configured unverified key", status: { valid: false, configured: true, checked: false }, ready: true, checking: false },
  { name: "missing key", status: { valid: false, configured: false, checked: false }, ready: false, checking: false },
  { name: "rejected key", status: { valid: false, configured: true, checked: true }, ready: false, checking: false },
  { name: "pending check", status: { valid: false, configured: true, checked: false, checking: true }, ready: false, checking: true },
  { name: "old verified snapshot", status: { valid: true }, ready: true, checking: false },
  { name: "old missing or rejected snapshot", status: { valid: false, maskedKey: "••••abcd" }, ready: false, checking: false },
  { name: "old pending snapshot", status: { valid: false, error: "Checking Exa connection" }, ready: false, checking: true },
  { name: "settled snapshot with an old pending message", status: { valid: false, configured: true, checked: false, error: "Checking Exa connection" }, ready: true, checking: false },
])("$name has honest readiness", ({ status, ready, checking }) => {
  // Exercise the process boundary too: unknown fields would otherwise disappear in Zod parsing.
  const parsed = ValidationStateSchema.shape.exa.parse(status);
  expect(parsed).toEqual(status);
  expect(isSearchProviderReady(parsed)).toBe(ready);
  expect(isSearchProviderChecking(parsed)).toBe(checking);
});
