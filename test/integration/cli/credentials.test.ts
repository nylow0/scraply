import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

const windowsTest = process.platform === "win32" && process.arch === "x64" ? test : test.skip;
const checkout = resolve(import.meta.dir, "../../..");
const electron = join(checkout, "node_modules/electron/dist/electron.exe");
const electronFixture = join(checkout, "test/fixtures/cli-electron-credentials.cjs");
const children = new Set<ReturnType<typeof spawn>>();
let root = "";
let executable = "";
const environment: NodeJS.ProcessEnv = { ...process.env, EXA_API_KEY: "", PERPLEXITY_API_KEY: "", SCRAPLY_DEV_SHARED_CREDENTIALS: "0" };
delete environment.ELECTRON_RUN_AS_NODE;
const Result = z.object({ ok: z.literal(true) });
const Presence = z.object({ running: z.boolean(), pid: z.number().nullable() });
const secretSamples = ["synthetic-electron-exa", "synthetic-electron-account", "synthetic-cli-exa",
  "synthetic-cli-perplexity", "synthetic-cli-account", "synthetic-electron-reply", "synthetic-secret-marker"];
const diagnosticValues = {
  modes: ["unknown", "detect", "invalid", "electron-read", "initialize", "reply-read", "crypto", "stale",
    "writer-exa", "writer-openai", "writer-other", "verify-concurrent", "diagnostic"],
  phases: ["unknown", "arguments", "profile", "detect", "invalid", "encryption", "load", "electron-read", "initialize",
    "reply-read", "crypto", "stale", "writer-gate", "writer-lock", "writer-hold", "writer-write-and-unlock",
    "verify-concurrent", "plaintext-check", "disposed-check", "diagnostic"],
  names: ["other", "Error", "TypeError", "AppError", "SyntaxError", "RangeError", "ZodError"],
  codes: ["other", "none", "EADDRINUSE", "ERR_INVALID_ARG_TYPE", "ENOENT", "EACCES", "EPERM", "EBUSY", "EEXIST",
    "ENOTDIR", "EIO", "EMFILE", "ENFILE", "internal_error", "secure_storage_unavailable"],
  messageClasses: ["redacted", "lock-exhausted", "pipe-bind", "read-failed", "stale-conflict", "crypto-initialization",
    "encryption-failed", "decryption-failed", "assertion", "gate-timeout", "missing-profile", "missing-writer-paths",
    "expected-rejection", "unknown-mode"],
} as const;
const WorkerFailure = z.object({
  mode: z.enum(diagnosticValues.modes), phase: z.enum(diagnosticValues.phases), name: z.enum(diagnosticValues.names),
  code: z.enum(diagnosticValues.codes), messageClass: z.enum(diagnosticValues.messageClasses),
}).strict();

// Keep this classifier self-contained apart from diagnosticValues: the compiled
// fixture embeds this same function, so its redaction is exercised across processes.
function classifyWorkerFailure(error: unknown, mode: string, phase: string) {
  const name = error instanceof Error ? error.name : "other";
  const code = error instanceof Error && "code" in error ? error.code : "none";
  const message = error instanceof Error ? error.message : "";
  const fixedMessages = [
    ["Credential storage is busy. Try again.", "lock-exhausted"],
    ["Saved credentials could not be read. The encrypted file has been left untouched.", "read-failed"],
    ["Credentials changed in another Scraply instance. Restart this instance before changing the account or keys.", "stale-conflict"],
    ["Windows credential encryption could not be initialized. Saved credentials and Local State have been left untouched.", "crypto-initialization"],
    ["Credentials could not be encrypted.", "encryption-failed"],
    ["Saved credentials could not be decrypted. The encrypted file has been left untouched.", "decryption-failed"],
    ["Synthetic assertion failed", "assertion"], ["Writer gate timeout", "gate-timeout"],
    ["Missing synthetic profile", "missing-profile"], ["Missing writer paths", "missing-writer-paths"],
    ["Expected credential rejection", "expected-rejection"], ["Unknown synthetic mode", "unknown-mode"],
  ] as const;
  const pipeBind = /^Failed to listen at \\\\.\\pipe\\scraply-credentials-[a-f0-9]{32}$/.test(message);
  return {
    mode: diagnosticValues.modes.find(value => value === mode) ?? "unknown",
    phase: diagnosticValues.phases.find(value => value === phase) ?? "unknown",
    name: diagnosticValues.names.find(value => value === name) ?? "other",
    code: diagnosticValues.codes.find(value => value === code) ?? "other",
    messageClass: fixedMessages.find(([value]) => value === message)?.[1] ?? (pipeBind ? "pipe-bind" : "redacted"),
  };
}

function workerFailureSuffix(output: string, args: readonly string[]) {
  const [mode, , field] = args;
  const childMode = mode === "writer"
    ? field === "exa" ? "writer-exa" : field === "openai" ? "writer-openai" : "writer-other"
    : diagnosticValues.modes.find(value => value === mode) ?? "unknown";
  const unavailable = `; mode=${childMode}; diagnostic=unavailable`;
  try {
    const parsed = WorkerFailure.safeParse(JSON.parse(output));
    if (!parsed.success) return unavailable;
    const { mode, phase, name, code, messageClass } = parsed.data;
    return `; mode=${mode}; phase=${phase}; name=${name}; code=${code}; messageClass=${messageClass}`;
  } catch { return unavailable; }
}

function start(command: string, args: string[]) {
  const child = spawn(command, args, { cwd: checkout, env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on("data", chunk => stdout.push(Buffer.from(chunk)));
  child.stderr?.on("data", chunk => stderr.push(Buffer.from(chunk)));
  let timer: ReturnType<typeof setTimeout>;
  const finished = new Promise<string>((resolveDone, reject) => {
    timer = setTimeout(() => { child.kill(); reject(new Error("Synthetic credential subprocess timed out")); }, 60000);
    child.once("error", reject);
    child.once("close", code => {
      children.delete(child);
      const output = Buffer.concat(stdout).toString("utf8");
      const errors = Buffer.concat(stderr).toString("utf8");
      if (secretSamples.some(value => output.includes(value) || errors.includes(value))) {
        reject(new Error("Synthetic credential subprocess leaked a credential"));
      } else if (code !== 0) {
        // Only the compiled fixture's exact allowlisted report may leave the child.
        // Compiler, Electron, malformed, and unexpected output remain fully masked.
        const diagnostic = command === executable ? workerFailureSuffix(errors, args) : "";
        reject(new Error(`Synthetic ${command === electron ? "Electron" : "credential worker"} subprocess exited ${code}${diagnostic}`));
      } else resolveDone(output);
    });
  }).finally(() => clearTimeout(timer));
  void finished.catch(() => {});
  return { child, finished };
}

async function waitFor(path: string) {
  const deadline = Date.now() + 10000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error("Synthetic credential readiness timed out");
    await delay(20);
  }
}

async function probe(mode: string, profile: string, ...args: string[]) {
  return z.unknown().parse(JSON.parse(await start(executable, [mode, profile, ...args]).finished));
}

async function electronRun(mode: string, profile: string) {
  const output = join(root, `${mode}-${crypto.randomUUID()}.json`);
  const config = `${output}.config.json`;
  const stopFile = `${output}.stop`;
  writeFileSync(config, JSON.stringify({ mode, profile, output, stopFile }));
  const process = start(electron, [electronFixture, config]);
  if (mode === "hold") await waitFor(output);
  else await process.finished;
  return { ...process, output, stopFile };
}

beforeAll(async () => {
  if (process.platform !== "win32" || process.arch !== "x64") return;
  if (!existsSync(electron)) throw new Error("Install the pinned Electron executable before running credential upgrade tests");
  const parent = join(checkout, "build/cli-credentials-tests");
  mkdirSync(parent, { recursive: true });
  root = mkdtempSync(join(parent, "run-"));
  executable = join(root, "credential-worker.exe");
  environment.SCRAPLY_CREDENTIAL_TEST_ROOT = root;
  environment.SCRAPLY_DEV_DATA_DIR = join(root, "unused-isolated-profile");
  const source = join(root, "credential-worker.ts");
  // Compile the production modules into a real standalone Windows executable.
  // Generated code and all runtime artifacts remain in ignored build/.
  writeFileSync(source, `
import { createWindowsEncryption } from ${JSON.stringify(join(checkout, "src/cli/oscrypt.ts"))};
import { detectLegacyDesktop } from ${JSON.stringify(join(checkout, "src/cli/legacy-desktop.ts"))};
import { createCredentialStore } from ${JSON.stringify(join(checkout, "src/main/credential-store.ts"))};
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const diagnosticValues = ${JSON.stringify(diagnosticValues)};
const classifyWorkerFailure = ${classifyWorkerFailure.toString()};
let failureMode = "unknown";
let failurePhase = "arguments";
function check(ok: unknown) { if (!ok) throw new Error("Synthetic assertion failed"); }
function rejected(operation: () => unknown) {
  try { operation(); } catch (error) {
    check(error instanceof Error && !error.message.includes("synthetic-secret-marker"));
    return;
  }
  throw new Error("Expected credential rejection");
}
const cliSecrets = { exaApiKey: "synthetic-cli-exa", perplexityApiKey: "synthetic-cli-perplexity",
  providerCredentials: { openai: "synthetic-cli-account" } };
async function main() {
  const [mode, supplied, ...args] = process.argv.slice(2);
  failureMode = mode === "writer"
    ? args[0] === "exa" ? "writer-exa" : args[0] === "openai" ? "writer-openai" : "writer-other"
    : mode ?? "unknown";
  const root = process.env.SCRAPLY_CREDENTIAL_TEST_ROOT;
  if (!supplied || !root) throw new Error("Missing synthetic profile");
  failurePhase = "profile";
  const profile = resolve(supplied);
  check(profile.toLowerCase().startsWith(resolve(root).toLowerCase() + sep));
  if (mode === "diagnostic") {
    failurePhase = "diagnostic";
    const privateValue = args[0] ?? "synthetic-secret-marker";
    const error = new Error(privateValue + " " + join(profile, "secrets.bin"));
    error.name = privateValue;
    error.stack = privateValue;
    throw Object.assign(error, { code: privateValue, cause: privateValue });
  }
  if (mode === "detect") { failurePhase = "detect"; console.log(JSON.stringify(detectLegacyDesktop(profile))); return; }
  if (mode === "invalid") {
    failurePhase = "invalid";
    mkdirSync(profile, { recursive: true });
    const cases = [null, {}, { os_crypt: {} }, { os_crypt: { encrypted_key: "" } },
      { os_crypt: { encrypted_key: "synthetic-secret-marker" } }, { os_crypt: { encrypted_key: "RFBBUEk=" } },
      { os_crypt: { encrypted_key: "RFBBUElqdW5r" } }, { os_crypt: null }];
    for (let index = 0; index < cases.length; index++) {
      const directory = join(profile, "invalid-" + index);
      mkdirSync(directory);
      const state = join(directory, "Local State");
      const secrets = join(directory, "secrets.bin");
      const value = cases[index];
      if (value !== null) writeFileSync(state, JSON.stringify(value));
      writeFileSync(secrets, "synthetic-secret-marker");
      const before = existsSync(state) ? readFileSync(state) : null;
      rejected(() => createWindowsEncryption(directory));
      check(before ? readFileSync(state).equals(before) : !existsSync(state));
      check(readFileSync(secrets, "utf8") === "synthetic-secret-marker");
      if (index >= 3) {
        const withoutSecrets = join(profile, "invalid-empty-" + index);
        mkdirSync(withoutSecrets);
        const statePath = join(withoutSecrets, "Local State");
        writeFileSync(statePath, JSON.stringify(value));
        const original = readFileSync(statePath);
        rejected(() => createWindowsEncryption(withoutSecrets));
        check(readFileSync(statePath).equals(original));
      }
    }
    for (const contents of [Buffer.from("{synthetic-secret-marker"), Buffer.from([0xff]), Buffer.from("[]")]) {
      const directory = join(profile, "malformed-" + crypto.randomUUID());
      mkdirSync(directory);
      const path = join(directory, "Local State");
      writeFileSync(path, contents);
      rejected(() => createWindowsEncryption(directory));
      check(readFileSync(path).equals(contents));
    }
    console.log(JSON.stringify({ ok: true })); return;
  }
  failurePhase = "encryption";
  const encryption = createWindowsEncryption(profile);
  try {
    const path = join(profile, "secrets.bin");
    const store = createCredentialStore(path, encryption);
    failurePhase = "load";
    const saved = store.load();
    if (mode === "electron-read") {
      failurePhase = "electron-read";
      check(saved.exaApiKey === "synthetic-electron-exa" && saved.providerCredentials.openai === "synthetic-electron-account");
      await store.save(cliSecrets);
    } else if (mode === "initialize") {
      failurePhase = "initialize";
      check(saved.exaApiKey === null && saved.perplexityApiKey === null);
      await store.save(cliSecrets);
    } else if (mode === "reply-read") {
      failurePhase = "reply-read";
      check(saved.exaApiKey === "synthetic-electron-reply" && saved.perplexityApiKey === cliSecrets.perplexityApiKey &&
        saved.providerCredentials.openai === cliSecrets.providerCredentials.openai);
    } else if (mode === "crypto") {
      failurePhase = "crypto";
      for (const value of ["", "synthetic text", "Привіт 🌒 café\\u0000"]) check(encryption.decryptString(encryption.encryptString(value)) === value);
      const blob = encryption.encryptString("synthetic-secret-marker");
      for (const changed of [Buffer.alloc(0), blob.subarray(0, 30), Buffer.concat([Buffer.from("v11"), blob.subarray(3)]),
        Buffer.concat([blob.subarray(0, -1), Buffer.from([blob.at(-1)! ^ 1])])]) rejected(() => encryption.decryptString(changed));
      rejected(() => encryption.encryptString("\\ud800"));
      const other = createWindowsEncryption(join(profile, "other-profile"));
      try { rejected(() => other.decryptString(blob)); } finally { other.dispose(); }
      writeFileSync(path, "synthetic-secret-marker");
      rejected(() => createCredentialStore(path, encryption).load());
      let failed = false;
      try { await store.save(cliSecrets); } catch { failed = true; }
      check(failed && readFileSync(path, "utf8") === "synthetic-secret-marker");
    } else if (mode === "stale") {
      failurePhase = "stale";
      const second = createCredentialStore(path, encryption);
      const stale = second.load();
      await store.save({ ...saved, exaApiKey: "synthetic-new-key" });
      await second.save({ ...stale, perplexityApiKey: "synthetic-independent-key" });
      let failed = false;
      try { await second.save({ ...stale, exaApiKey: "synthetic-stale-key" }); } catch { failed = true; }
      check(failed);
      const actual = createCredentialStore(path, encryption).load();
      check(actual.exaApiKey === "synthetic-new-key" && actual.perplexityApiKey === "synthetic-independent-key");
    } else if (mode === "writer") {
      const [field, ready, gate, locked] = args;
      failurePhase = "writer-gate";
      if (!ready || !gate || !locked) throw new Error("Missing writer paths");
      writeFileSync(ready, "ready");
      const deadline = Date.now() + 10000;
      while (!existsSync(gate)) { if (Date.now() >= deadline) throw new Error("Writer gate timeout"); await delay(10); }
      if (field === "exa") saved.exaApiKey = "synthetic-concurrent-exa";
      else saved.providerCredentials.openai = "synthetic-concurrent-account";
      failurePhase = "writer-lock";
      await store.save(saved, () => {
        failurePhase = "writer-hold";
        if (field === "exa") { writeFileSync(locked, "locked"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500); }
        failurePhase = "writer-write-and-unlock";
      });
    } else if (mode === "verify-concurrent") {
      failurePhase = "verify-concurrent";
      check(saved.exaApiKey === "synthetic-concurrent-exa" && saved.providerCredentials.openai === "synthetic-concurrent-account");
    } else throw new Error("Unknown synthetic mode");
    failurePhase = "plaintext-check";
    if (existsSync(path) && mode !== "crypto") check(!readFileSync(path).includes(Buffer.from("synthetic-")));
  } finally { encryption.dispose(); }
  failurePhase = "disposed-check";
  check(!encryption.isEncryptionAvailable());
  rejected(() => encryption.encryptString("synthetic-secret-marker"));
  rejected(() => encryption.decryptString(Buffer.alloc(31)));
  console.log(JSON.stringify({ ok: true }));
}
main().catch(error => {
  console.error(JSON.stringify(classifyWorkerFailure(error, failureMode, failurePhase)));
  process.exitCode = 1;
});
`);
  await start("bun", ["--no-env-file", "build", "--compile", "--target=bun-windows-x64", source, "--outfile", executable]).finished;
}, 60000);

afterAll(async () => {
  for (const child of children) child.kill();
  if (children.size) await delay(150);
  if (root) rmSync(root, { recursive: true, force: true });
});

windowsTest("compiled credential failure diagnostics exclude credential-bearing exceptions and reject untrusted reports", async () => {
  const marker = "synthetic-secret-marker";
  const expected = "; mode=diagnostic; phase=diagnostic; name=other; code=other; messageClass=redacted";
  await expect(start(executable, ["diagnostic", join(root, "diagnostic-profile"), marker]).finished)
    .rejects.toThrow(`Synthetic credential worker subprocess exited 1${expected}`);

  const args = ["diagnostic"];
  const unavailable = "; mode=diagnostic; diagnostic=unavailable";
  const failure = classifyWorkerFailure(new Error(marker), "diagnostic", "diagnostic");
  expect(workerFailureSuffix(JSON.stringify(failure), args)).toBe("; mode=diagnostic; phase=diagnostic; name=Error; code=none; messageClass=redacted");
  for (const field of Object.keys(failure)) {
    expect(workerFailureSuffix(JSON.stringify({ ...failure, [field]: marker }), args)).toBe(unavailable);
  }
  for (const untrusted of [marker, JSON.stringify({ ...failure, message: marker }), JSON.stringify([failure]),
    JSON.stringify({ mode: "diagnostic" }), JSON.stringify(failure) + "\n" + marker]) {
    expect(workerFailureSuffix(untrusted, args)).toBe(unavailable);
  }
  for (const [childArgs, childMode] of [
    [["initialize", marker], "initialize"], [["writer", marker, "exa"], "writer-exa"],
    [["writer", marker, "openai"], "writer-openai"], [["writer", marker, marker], "writer-other"],
    [["verify-concurrent", marker], "verify-concurrent"], [[marker, marker, marker], "unknown"],
  ] as const) {
    for (const report of ["", marker]) {
      expect(workerFailureSuffix(report, childArgs)).toBe(`; mode=${childMode}; diagnostic=unavailable`);
    }
  }
});

windowsTest("compiled Bun reads Electron credentials and Electron reads its saved keys and account", async () => {
  const profile = join(root, "electron-first");
  const first = await electronRun("electron-first", profile);
  expect(Result.parse(JSON.parse(readFileSync(first.output, "utf8"))).ok).toBe(true);
  expect(Result.parse(await probe("electron-read", profile)).ok).toBe(true);
  await electronRun("verify-cli", profile);
  expect(Result.parse(await probe("reply-read", profile)).ok).toBe(true);
}, 30000);

windowsTest("Electron adopts CLI-first credentials and initialization preserves Local State fields", async () => {
  for (const existingState of [false, true]) {
    const profile = join(root, existingState ? "cli-existing-state" : "cli-first");
    if (existingState) {
      mkdirSync(profile);
      writeFileSync(join(profile, "Local State"), JSON.stringify({ custom: { keep: true }, os_crypt: { audit_enabled: false } }));
    }
    expect(Result.parse(await probe("initialize", profile)).ok).toBe(true);
    const state: unknown = JSON.parse(readFileSync(join(profile, "Local State"), "utf8"));
    expect(state).toEqual(existingState
      ? { custom: { keep: true }, os_crypt: { audit_enabled: false, encrypted_key: expect.any(String) } }
      : { os_crypt: { encrypted_key: expect.any(String) } });
    await electronRun("verify-cli", profile);
    expect(Result.parse(await probe("reply-read", profile)).ok).toBe(true);
  }
}, 30000);

windowsTest("invalid keys and stores fail closed, authenticated blobs round trip, disposal rejects use", async () => {
  expect(Result.parse(await probe("invalid", join(root, "invalid-profiles"))).ok).toBe(true);
  expect(Result.parse(await probe("crypto", join(root, "crypto-profile"))).ok).toBe(true);
  expect(Result.parse(await probe("stale", join(root, "stale-profile"))).ok).toBe(true);
}, 30000);

windowsTest("compiled Bun writers serialize occupied credential pipes and merge independent changes", async () => {
  const profile = join(root, "concurrent-profile");
  expect(Result.parse(await probe("initialize", profile)).ok).toBe(true);
  const ready = [join(root, "writer-one.ready"), join(root, "writer-two.ready")];
  const gates = [join(root, "writer-one.go"), join(root, "writer-two.go")];
  const locked = join(root, "writer-one.locked");
  const first = start(executable, ["writer", profile, "exa", ready[0]!, gates[0]!, locked]);
  const second = start(executable, ["writer", profile, "openai", ready[1]!, gates[1]!, locked]);
  await Promise.all(ready.map(waitFor));
  writeFileSync(gates[0]!, "go");
  await waitFor(locked);
  writeFileSync(gates[1]!, "go");
  await Promise.all([first.finished, second.finished]);
  expect(Result.parse(await probe("verify-concurrent", profile)).ok).toBe(true);
}, 30000);

windowsTest("legacy singleton lookup finds only the owned Electron profile, including path aliases", async () => {
  const profile = join(root, "singleton-profile");
  expect(Presence.parse(await probe("detect", profile))).toEqual({ running: false, pid: null });
  const held = await electronRun("hold", profile);
  try {
    if (!held.child.pid) throw new Error("Synthetic Electron fixture has no process id");
    const expected = { running: true, pid: held.child.pid };
    expect(Presence.parse(await probe("detect", profile))).toEqual(expected);
    expect(Presence.parse(await probe("detect", profile.toUpperCase()))).toEqual(expected);
    const alias = join(root, "singleton-junction");
    symlinkSync(profile, alias, "junction");
    expect(Presence.parse(await probe("detect", alias))).toEqual(expected);
    const other = join(root, "other-profile");
    mkdirSync(other);
    expect(Presence.parse(await probe("detect", other))).toEqual({ running: false, pid: null });
  } finally {
    writeFileSync(held.stopFile, "stop");
    await held.finished;
  }
  expect(Presence.parse(await probe("detect", profile))).toEqual({ running: false, pid: null });
}, 30000);
