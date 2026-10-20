/* eslint-disable @typescript-eslint/no-require-imports */
const { app, safeStorage } = require("electron");
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { join, resolve, sep } = require("node:path");

// Only the integration test's explicitly isolated root is accepted. No real profile
// or plaintext credential file is ever read or written by this fixture.
function owned(value) {
  const root = process.env.SCRAPLY_CREDENTIAL_TEST_ROOT;
  if (!root || !value) throw new Error("Missing synthetic test path");
  const path = resolve(value);
  if (!path.toLowerCase().startsWith(`${resolve(root).toLowerCase()}${sep}`)) throw new Error("Unowned test path");
  return path;
}

async function main() {
  const config = JSON.parse(readFileSync(owned(process.argv[2]), "utf8"));
  const profile = owned(config.profile);
  const output = owned(config.output);
  mkdirSync(profile, { recursive: true });
  app.setName("scraply-synthetic-credential-test");
  app.setPath("userData", profile);
  app.setPath("sessionData", profile);
  app.setPath("crashDumps", profile);
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-background-networking");
  if (!app.requestSingleInstanceLock()) throw new Error("Synthetic singleton lock unavailable");
  await app.whenReady();
  if (process.versions.electron !== "42.7.0") throw new Error("Credential upgrade gate requires Electron 42.7.0");
  if (config.mode === "hold") {
    const stop = owned(config.stopFile);
    writeFileSync(output, JSON.stringify({ ready: true, pid: process.pid }));
    setInterval(() => { if (existsSync(stop)) app.quit(); }, 25);
    setTimeout(() => app.quit(), 30000);
    return;
  }
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows encryption unavailable");
  const path = join(profile, "secrets.bin");
  if (config.mode === "electron-first") {
    writeFileSync(path, safeStorage.encryptString(JSON.stringify({
      exaApiKey: "synthetic-electron-exa", perplexityApiKey: null,
      providerCredentials: { openai: "synthetic-electron-account" },
    })));
  } else if (config.mode === "verify-cli") {
    const saved = JSON.parse(safeStorage.decryptString(readFileSync(path)));
    if (saved.exaApiKey !== "synthetic-cli-exa" || saved.perplexityApiKey !== "synthetic-cli-perplexity" ||
      saved.providerCredentials.openai !== "synthetic-cli-account") throw new Error("CLI credential mismatch");
    saved.exaApiKey = "synthetic-electron-reply";
    writeFileSync(path, safeStorage.encryptString(JSON.stringify(saved)));
  } else throw new Error("Unknown synthetic fixture mode");
  writeFileSync(output, JSON.stringify({ ok: true, electron: process.versions.electron }));
  app.quit();
}

main().catch(() => {
  console.error("Synthetic Electron credential fixture failed");
  app.exit(1);
});
