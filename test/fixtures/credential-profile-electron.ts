import { app, safeStorage } from "electron";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { configureCredentialProfile } from "../../src/main/credential-profile";
import { createCredentialStore } from "../../src/main/credential-store";

const [root, mode] = process.argv.slice(2);
if (!root || !mode) throw new Error("Missing isolated fixture arguments");
// Override appData as well as userData so this integration test cannot read real credentials.
const installedProfile = join(root, "scraply");
const devProfile = join(root, "development");
mkdirSync(installedProfile, { recursive: true });
mkdirSync(devProfile, { recursive: true });
app.setPath("appData", root);
app.setPath("userData", mode === "seed" || mode === "desktop" ? installedProfile : devProfile);
const { projectProfile, credentialsPath } = configureCredentialProfile(app, {
  SCRAPLY_DEV_SHARED_CREDENTIALS: mode === "isolated" ? "0" : "1",
  SCRAPLY_E2E: mode === "e2e" ? "1" : "0",
});
app.whenReady().then(async () => {
  const store = createCredentialStore(credentialsPath, safeStorage);
  const loaded = store.load();
  if (mode === "seed") {
    await store.save({ exaApiKey: "synthetic-exa", perplexityApiKey: "synthetic-perplexity", providerCredentials: { openai: "synthetic-login" } });
  } else if (mode === "shared") {
    assert.equal(projectProfile, devProfile);
    assert.equal(app.getPath("sessionData"), installedProfile);
    assert.equal(loaded.exaApiKey, "synthetic-exa");
    assert.equal(loaded.perplexityApiKey, "synthetic-perplexity");
    assert.equal(loaded.providerCredentials.openai, "synthetic-login");
    await store.save({ ...loaded, providerCredentials: { openai: "synthetic-refresh" } });
  } else if (mode === "desktop") {
    assert.equal(loaded.providerCredentials.openai, "synthetic-refresh");
    assert.equal(loaded.exaApiKey, "synthetic-exa");
  } else {
    assert.deepEqual(loaded, { exaApiKey: null, perplexityApiKey: null, providerCredentials: {} });
    assert.equal(credentialsPath, join(devProfile, "secrets.bin"));
  }
  console.log(`credential-profile:${mode}:passed`);
  app.quit();
}).catch(error => { console.error(error instanceof Error ? error.message : "Fixture failed"); app.exit(1); });
