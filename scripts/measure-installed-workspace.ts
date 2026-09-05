import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createInstalledPerformanceFixture, type InstalledPerformanceFixture } from "./create-installed-performance-fixture";

const BASELINE_EXECUTABLE_SHA256 = "96c932430384ed31b9494d7a92c229cbc4be619346333799e6afe5d6401e125e";
const COLD_SAMPLES_PER_MODE = 10;
const WARM_WORKSPACE_SAMPLES = 30;
const SWITCH_AND_DETAIL_SAMPLES = 100;
const READINESS_TIMEOUT_MS = 15_000;
const UI_TARGET_MS = 2_000;
const WARM_DETAIL_P95_TARGET_MS = 250;

type Mode = "empty" | "synthetic";
type JsonObject = Record<string, unknown>;

interface CdpResponse {
  id?: number;
  method?: string;
  params?: JsonObject;
  result?: JsonObject;
  error?: { message: string };
}

interface WorkspaceShape {
  activeThreadId: string | null;
  threads: Array<{ id: string; title: string }>;
  problemCandidates: Array<{ factors: Array<{ sourceId: string }> }>;
  solutions: Array<{ id: string }>;
  validation: {
    codex: { detected: boolean };
    native: { available: boolean; connected: boolean; version?: string; accounts: unknown[] };
  };
}

interface IpcSample<T> {
  durationMs: number;
  responseBytes: number;
  value: T;
}

interface ProcessMemory {
  pid: number;
  parentPid: number;
  role: string;
  workingSetBytes: number;
  privateBytes: number;
}

interface NetworkObservation {
  requestCount: number;
  responseCount: number;
  encodedResponseBytes: number;
}

interface LaunchSession {
  mode: Mode;
  index: number;
  process: ReturnType<typeof Bun.spawn>;
  cdp: CdpClient;
  profileRoot: string;
  launchedAt: number;
  network: NetworkObservation;
  cold: {
    sampleSequence: number;
    mode: Mode;
    index: number;
    rendererTargetMs: number;
    rendererConnectedMs: number;
    usableUiMs: number;
    nativeReadyMs: number;
    workspaceResponseBytes: number;
    projectCount: number;
    solutionCount: number;
    visibleFactorSourceCount: number;
  };
}

class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: JsonObject) => void; reject: (error: Error) => void }>();
  private readonly notificationHandlers = new Set<(method: string, params: JsonObject) => void>();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const response = JSON.parse(String(event.data)) as CdpResponse;
      if (response.id !== undefined) {
        const request = this.pending.get(response.id);
        if (!request) return;
        this.pending.delete(response.id);
        if (response.error) request.reject(new Error(response.error.message));
        else request.resolve(response.result ?? {});
        return;
      }
      if (response.method) {
        for (const handler of this.notificationHandlers) handler(response.method, response.params ?? {});
      }
    });
  }

  static async connect(url: string): Promise<CdpClient> {
    const socket = new WebSocket(url);
    await bounded("CDP WebSocket connection", 5_000, new Promise<void>((resolveConnection, rejectConnection) => {
      socket.addEventListener("open", () => resolveConnection(), { once: true });
      socket.addEventListener("error", () => rejectConnection(new Error("CDP WebSocket connection failed")), { once: true });
    }));
    return new CdpClient(socket);
  }

  call(method: string, params: JsonObject = {}): Promise<JsonObject> {
    const id = this.nextId++;
    return new Promise((resolveCall, rejectCall) => {
      this.pending.set(id, { resolve: resolveCall, reject: rejectCall });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  onNotification(handler: (method: string, params: JsonObject) => void): void {
    this.notificationHandlers.add(handler);
  }

  close(): void {
    this.socket.close();
  }
}

const root = resolve(import.meta.dir, "..");
const executablePath = join(process.env.LOCALAPPDATA ?? "", "Programs", "Scraply", "Scraply.exe");
const executableSha256 = sha256(executablePath);
const expectedSha256 = argument("--expected-exe-sha") ?? BASELINE_EXECUTABLE_SHA256;
const label = argument("--label") ?? "baseline076";
if (!/^[a-f0-9]{64}$/i.test(expectedSha256)) throw new Error("--expected-exe-sha must be a 64-character SHA-256 hash");
if (!/^[a-zA-Z0-9._-]+$/.test(label)) throw new Error("--label may contain only letters, numbers, dots, underscores, and hyphens");
if (executableSha256.toLowerCase() !== expectedSha256.toLowerCase()) {
  throw new Error(`Installed executable hash mismatch: expected ${expectedSha256}, received ${executableSha256}`);
}

const expectedRendererUrl = pathToFileURL(
  join(dirname(executablePath), "resources", "app.asar", "out", "renderer", "index.html"),
).href;
const runStarted = performance.now();
const runId = `${new Date().toISOString().replaceAll(":", "-")}-${label}-${executableSha256.slice(0, 12)}`;
const artifactDirectory = join(root, "build", "installed-performance", runId);
const fixturePath = join(artifactDirectory, "synthetic.db");
const rawPath = join(artifactDirectory, "raw-samples.json");
const reportPath = join(artifactDirectory, "report.json");
const eventsPath = join(artifactDirectory, "events.jsonl");
mkdirSync(artifactDirectory, { recursive: true });

const events: JsonObject[] = [];
const coldSamples: LaunchSession["cold"][] = [];
const warmWorkspaceSamples: JsonObject[] = [];
const switchSamples: JsonObject[] = [];
const localDetailSamples: JsonObject[] = [];
const ideaDetailSamples: JsonObject[] = [];
const sourceDetailSamples: JsonObject[] = [];
const ipcObserved = {
  workspace: { count: 0, responseBytes: 0 },
  ideaDetail: { count: 0, responseBytes: 0 },
  sourceDetail: { count: 0, responseBytes: 0 },
  selectThreadUiClicks: 0,
};
let retainedSynthetic: LaunchSession | null = null;
let measurementStartedAt: number | null = null;

function argument(name: string): string | undefined {
  const prefix = `${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function elapsedMs(): number {
  return performance.now() - runStarted;
}

function measurementElapsedMs(): number {
  if (measurementStartedAt === null) throw new Error("The measurement clock has not started");
  return performance.now() - measurementStartedAt;
}

function record(stage: string, detail: JsonObject = {}): void {
  const event = { sequence: events.length + 1, elapsedMs: elapsedMs(), stage, ...detail };
  events.push(event);
  writeFileSync(eventsPath, `${events.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
  console.log(JSON.stringify(event));
}

async function bounded<T>(label: string, timeoutMs: number, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isolatedEnvironment(): Record<string, string> {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const windowsRoot = process.env.SystemRoot ?? "C:\\Windows";
  environment.Path = `${join(windowsRoot, "System32")};${windowsRoot}`;
  environment.PATH = environment.Path;
  for (const name of [
    "EXA_API_KEY", "PERPLEXITY_API_KEY", "SCRAPLY_E2E", "SCRAPLY_E2E_BACKEND_URL",
    "SCRAPLY_E2E_BACKEND_TOKEN", "SCRAPLY_E2E_REAL_BACKEND",
  ]) delete environment[name];
  return environment;
}

async function reserveAvailablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListening, rejectListening) => {
    server.once("error", rejectListening);
    server.listen(0, "127.0.0.1", () => resolveListening());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a local debugging port");
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
  return address.port;
}

async function waitForPageTarget(port: number, process: ReturnType<typeof Bun.spawn>): Promise<string> {
  const deadline = performance.now() + READINESS_TIMEOUT_MS;
  while (performance.now() < deadline) {
    if (process.exitCode !== null) throw new Error(`Installed process exited before renderer readiness with ${process.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const targets = await response.json() as Array<{ type: string; url: string; webSocketDebuggerUrl?: string }>;
        const target = targets.find((item) => (
          item.type === "page" && item.url === expectedRendererUrl && item.webSocketDebuggerUrl
        ));
        if (target?.webSocketDebuggerUrl) return target.webSocketDebuggerUrl;
      }
    } catch {
      // The private endpoint rejects connections until Chromium is ready.
    }
    await Bun.sleep(50);
  }
  throw new Error(`Installed renderer readiness exceeded ${READINESS_TIMEOUT_MS}ms`);
}

async function evaluate<T>(cdp: CdpClient, expression: string, timeoutMs = 10_000): Promise<T> {
  const response = await bounded("Runtime.evaluate", timeoutMs, cdp.call("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })) as {
    result?: { value?: T };
    exceptionDetails?: { text?: string; exception?: { description?: string } };
  };
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? "Renderer evaluation failed");
  }
  return response.result?.value as T;
}

async function waitForValue<T>(
  labelText: string,
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  deadline: number,
): Promise<T> {
  while (performance.now() < deadline) {
    const value = await read();
    if (accept(value)) return value;
    await Bun.sleep(50);
  }
  throw new Error(`${labelText} exceeded ${READINESS_TIMEOUT_MS}ms`);
}

async function workspaceIpc(cdp: CdpClient): Promise<IpcSample<WorkspaceShape>> {
  const sample = await evaluate<IpcSample<WorkspaceShape>>(cdp, `(async () => {
    const started = performance.now();
    const value = await window.scraply.getWorkspace();
    return {
      durationMs: performance.now() - started,
      responseBytes: new TextEncoder().encode(JSON.stringify(value)).length,
      value,
    };
  })()`);
  ipcObserved.workspace.count += 1;
  ipcObserved.workspace.responseBytes += sample.responseBytes;
  return sample;
}

async function detailIpc<T>(cdp: CdpClient, kind: "ideaDetail" | "sourceDetail", id: string): Promise<IpcSample<T>> {
  const method = kind === "ideaDetail" ? "getIdeaDetail" : "getSourceDetail";
  const sample = await evaluate<IpcSample<T>>(cdp, `(async () => {
    const started = performance.now();
    const value = await window.scraply.${method}(${JSON.stringify(id)});
    return {
      durationMs: performance.now() - started,
      responseBytes: new TextEncoder().encode(JSON.stringify(value)).length,
      value,
    };
  })()`);
  ipcObserved[kind].count += 1;
  ipcObserved[kind].responseBytes += sample.responseBytes;
  return sample;
}

async function launch(mode: Mode, index: number, fixture: InstalledPerformanceFixture): Promise<LaunchSession> {
  const profileRoot = mkdtempSync(join(tmpdir(), `scraply-installed-performance-${mode}-`));
  const userDataDirectory = join(profileRoot, "profile");
  mkdirSync(userDataDirectory, { recursive: true });
  if (mode === "synthetic") {
    const dataDirectory = join(userDataDirectory, "scraply");
    mkdirSync(dataDirectory, { recursive: true });
    copyFileSync(fixture.databasePath, join(dataDirectory, "scraply.db"));
  }
  const port = await reserveAvailablePort();
  const launchedAt = performance.now();
  const process = Bun.spawn([
    executablePath,
    `--user-data-dir=${userDataDirectory}`,
    `--remote-debugging-port=${port}`,
  ], {
    env: isolatedEnvironment(),
    stdout: "ignore",
    stderr: "ignore",
    windowsHide: true,
  });
  let cdp: CdpClient | null = null;
  try {
    const endpoint = await waitForPageTarget(port, process);
    const rendererTargetMs = performance.now() - launchedAt;
    cdp = await CdpClient.connect(endpoint);
    await bounded("Runtime.enable", 5_000, cdp.call("Runtime.enable"));
    await bounded("Page.enable", 5_000, cdp.call("Page.enable"));
    await bounded("Network.enable", 5_000, cdp.call("Network.enable"));
    const rendererConnectedMs = performance.now() - launchedAt;
    const network: NetworkObservation = { requestCount: 0, responseCount: 0, encodedResponseBytes: 0 };
    cdp.onNotification((method, params) => {
      if (method === "Network.requestWillBeSent") network.requestCount += 1;
      if (method === "Network.responseReceived") network.responseCount += 1;
      if (method === "Network.loadingFinished" && typeof params.encodedDataLength === "number") {
        network.encodedResponseBytes += params.encodedDataLength;
      }
    });
    const deadline = launchedAt + READINESS_TIMEOUT_MS;
    await waitForValue(
      `${mode} UI readiness`,
      () => evaluate<{ body: string; projects: number; solutions: number }>(cdp!, `({
        body: document.body.innerText,
        projects: document.querySelectorAll('[aria-label^="Open thread "]').length,
        solutions: document.querySelectorAll('details.solution').length,
      })`),
      (value) => mode === "empty"
        ? value.body.includes("Create research") && value.projects === 0
        : value.body.includes("Synthetic project 01") && value.projects === 20 && value.solutions === 20,
      deadline,
    );
    const usableUiMs = performance.now() - launchedAt;
    const readyWorkspace = await waitForValue(
      `${mode} native readiness`,
      () => workspaceIpc(cdp!),
      (sample) => sample.value.validation.native.available,
      deadline,
    );
    const nativeReadyMs = performance.now() - launchedAt;
    if (readyWorkspace.value.validation.codex.detected) throw new Error("Codex was detected on the isolated probe PATH");
    if (readyWorkspace.value.validation.native.connected || readyWorkspace.value.validation.native.accounts.length > 0) {
      throw new Error("The isolated probe unexpectedly loaded a native provider account");
    }
    const projectCount = readyWorkspace.value.threads.length;
    const solutionCount = readyWorkspace.value.solutions.length;
    const visibleFactorSourceCount = new Set(
      readyWorkspace.value.problemCandidates.flatMap((problem) => problem.factors.map((factor) => factor.sourceId)),
    ).size;
    if (mode === "empty" && (projectCount !== 0 || solutionCount !== 0 || visibleFactorSourceCount !== 0)) {
      throw new Error(`Empty cold start loaded ${projectCount} projects, ${solutionCount} solutions, and ${visibleFactorSourceCount} factor sources`);
    }
    if (mode === "synthetic" && (projectCount !== 20 || solutionCount !== 20 || visibleFactorSourceCount !== 20)) {
      throw new Error(`Synthetic cold start loaded ${projectCount} projects, ${solutionCount} solutions, and ${visibleFactorSourceCount} factor sources`);
    }
    const cold = {
      sampleSequence: coldSamples.length + 1,
      mode,
      index,
      rendererTargetMs,
      rendererConnectedMs,
      usableUiMs,
      nativeReadyMs,
      workspaceResponseBytes: readyWorkspace.responseBytes,
      projectCount,
      solutionCount,
      visibleFactorSourceCount,
    };
    return { mode, index, process, cdp, profileRoot, launchedAt, network, cold };
  } catch (error) {
    cdp?.close();
    stopProcessTree(process.pid);
    await removeProfile(profileRoot);
    throw error;
  }
}

function stopProcessTree(pid: number): void {
  const result = Bun.spawnSync(["taskkill", "/PID", String(pid), "/T", "/F"], {
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  if (result.exitCode !== 0) {
    const stderr = new TextDecoder().decode(result.stderr).trim();
    if (!stderr.includes("not found")) throw new Error(`Could not stop installed process tree ${pid}: ${stderr}`);
  }
}

async function removeProfile(profileRoot: string): Promise<void> {
  const temporaryDirectory = resolve(tmpdir());
  const target = resolve(profileRoot);
  if (dirname(target) !== temporaryDirectory || !target.startsWith(join(temporaryDirectory, "scraply-installed-performance-"))) {
    throw new Error(`Refusing to remove unexpected profile path ${target}`);
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(target, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 19) throw error;
      await Bun.sleep(100);
    }
  }
}

async function closeSession(session: LaunchSession): Promise<void> {
  session.cdp.close();
  stopProcessTree(session.process.pid);
  await removeProfile(session.profileRoot);
}

function processMemory(rootPid: number): ProcessMemory[] {
  const command = String.raw`
$allProcesses = Get-CimInstance Win32_Process
$treeIds = [System.Collections.Generic.HashSet[int]]::new()
[void]$treeIds.Add(${rootPid})
do {
  $changed = $false
  foreach ($item in $allProcesses) {
    if ($treeIds.Contains([int]$item.ParentProcessId) -and $treeIds.Add([int]$item.ProcessId)) { $changed = $true }
  }
} while ($changed)
$rows = foreach ($item in $allProcesses) {
  if (-not $treeIds.Contains([int]$item.ProcessId)) { continue }
  $live = Get-Process -Id $item.ProcessId -ErrorAction SilentlyContinue
  if (-not $live) { continue }
  $role = if ($item.ProcessId -eq ${rootPid}) { 'main' }
    elseif ($item.CommandLine -match '--type=renderer') { 'renderer' }
    elseif ($item.CommandLine -match '--type=gpu-process') { 'gpu' }
    elseif ($item.CommandLine -match '--type=utility') { 'utility' }
    else { 'child' }
  [pscustomobject]@{
    pid = [int]$item.ProcessId
    parentPid = [int]$item.ParentProcessId
    role = $role
    workingSetBytes = [long]$live.WorkingSet64
    privateBytes = [long]$live.PrivateMemorySize64
  }
}
@($rows) | ConvertTo-Json -Compress
`;
  const result = Bun.spawnSync(["powershell", "-NoProfile", "-Command", command], {
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr).trim());
  const output = new TextDecoder().decode(result.stdout).trim();
  if (!output) return [];
  const parsed = JSON.parse(output) as ProcessMemory | ProcessMemory[];
  return Array.isArray(parsed) ? parsed : [parsed];
}

function memorySummary(processes: ProcessMemory[]) {
  return {
    processCount: processes.length,
    workingSetBytes: processes.reduce((total, process) => total + process.workingSetBytes, 0),
    privateBytes: processes.reduce((total, process) => total + process.privateBytes, 0),
    processes,
  };
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) throw new Error("Cannot summarize an empty sample set");
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!;
}

function summary(values: number[]) {
  return {
    samples: values.length,
    minMs: Math.min(...values),
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    maxMs: Math.max(...values),
  };
}

async function existingScraplyProcesses(): Promise<number[]> {
  const result = Bun.spawnSync([
    "powershell", "-NoProfile", "-Command",
    "@(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'Scraply.exe' } | Select-Object -ExpandProperty ProcessId) | ConvertTo-Json -Compress",
  ], { stdout: "pipe", stderr: "pipe", windowsHide: true });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr).trim());
  const output = new TextDecoder().decode(result.stdout).trim();
  if (!output) return [];
  const parsed = JSON.parse(output) as number | number[];
  return Array.isArray(parsed) ? parsed : [parsed];
}

function writeRaw(): void {
  writeFileSync(rawPath, `${JSON.stringify({
    capturedAt: new Date().toISOString(),
    coldSamples,
    warmWorkspaceSamples,
    switchSamples,
    localDetailSamples,
    ideaDetailSamples,
    sourceDetailSamples,
  }, null, 2)}\n`, "utf8");
}

const preexistingProcesses = await existingScraplyProcesses();
if (preexistingProcesses.length > 0) {
  throw new Error(`Refusing to measure while Scraply is already running: ${preexistingProcesses.join(", ")}`);
}

record("fixture-creation-started");
const fixture = createInstalledPerformanceFixture(fixturePath);
record("fixture-created", {
  sha256: fixture.databaseSha256,
  bytes: fixture.databaseBytes,
  schemaVersion: fixture.schemaVersion,
  counts: fixture.counts,
});
measurementStartedAt = performance.now();
record("measurement-clock-started", { preparationElapsedMs: elapsedMs() });

try {
  for (let index = 0; index < COLD_SAMPLES_PER_MODE; index += 1) {
    for (const mode of ["empty", "synthetic"] as const) {
      record("cold-start-begin", { mode, index });
      const session = await launch(mode, index, fixture);
      coldSamples.push(session.cold);
      record("cold-start-passed", session.cold);
      writeRaw();
      if (mode === "synthetic" && index === COLD_SAMPLES_PER_MODE - 1) retainedSynthetic = session;
      else await closeSession(session);
    }
  }
  if (!retainedSynthetic) throw new Error("No retained synthetic session was available for warm measurements");
  const session = retainedSynthetic;
  const initialMemory = memorySummary(processMemory(session.process.pid));
  record("warm-measurement-started", { pid: session.process.pid, initialMemory });

  for (let index = 0; index < WARM_WORKSPACE_SAMPLES; index += 1) {
    const sample = await workspaceIpc(session.cdp);
    warmWorkspaceSamples.push({
      sequence: index + 1,
      sampledAtMs: measurementElapsedMs(),
      durationMs: sample.durationMs,
      responseBytes: sample.responseBytes,
      activeThreadId: sample.value.activeThreadId,
      projectCount: sample.value.threads.length,
      solutionCount: sample.value.solutions.length,
    });
  }
  record("warm-workspace-complete", { samples: warmWorkspaceSamples.length });
  writeRaw();

  const projectTitles = Array.from({ length: 20 }, (_unused, index) => `Synthetic project ${String(index + 1).padStart(2, "0")}`);
  for (let index = 0; index < SWITCH_AND_DETAIL_SAMPLES; index += 1) {
    const title = projectTitles[(index + 1) % projectTitles.length]!;
    const switchResult = await evaluate<{
      durationMs: number;
      title: string;
      heading: string;
      ariaCurrent: string | null;
      solutionCount: number;
      firstMechanism: string;
    }>(session.cdp, `(async () => {
      const title = ${JSON.stringify(title)};
      const button = [...document.querySelectorAll('button')]
        .find((item) => item.getAttribute('aria-label') === 'Open thread ' + title);
      if (!button) throw new Error('Missing project button ' + title);
      const started = performance.now();
      button.click();
      const deadline = started + ${READINESS_TIMEOUT_MS};
      let observed = {};
      while (performance.now() < deadline) {
        const topbar = document.querySelector('.topbar > div')?.textContent?.trim() ?? '';
        const currentButton = [...document.querySelectorAll('button')]
          .find((item) => item.getAttribute('aria-label') === 'Open thread ' + title);
        const active = currentButton?.getAttribute('aria-current') === 'true';
        const solutions = [...document.querySelectorAll('details.solution')];
        const heading = document.querySelector('.workspace h1')?.textContent?.trim() ?? '';
        observed = { topbar, active, solutionCount: solutions.length, heading };
        if (topbar === title && active && solutions.length === 20 && heading.includes('20 solution ideas')) {
          await new Promise((resolve) => setTimeout(resolve, 0));
          return {
            durationMs: performance.now() - started,
            title: topbar,
            heading,
            ariaCurrent: currentButton?.getAttribute('aria-current') ?? null,
            solutionCount: solutions.length,
            firstMechanism: solutions[0]?.querySelector('.identity strong')?.textContent?.trim() ?? '',
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error('Rendered project switch timed out for ' + title + ': ' + JSON.stringify(observed));
    })()`, READINESS_TIMEOUT_MS + 1_000);
    ipcObserved.selectThreadUiClicks += 1;
    switchSamples.push({ sequence: index + 1, sampledAtMs: measurementElapsedMs(), targetTitle: title, ...switchResult });

    const workspace = await workspaceIpc(session.cdp);
    const selectedThread = workspace.value.threads.find((thread) => thread.title === title);
    if (!selectedThread || workspace.value.activeThreadId !== selectedThread.id || workspace.value.solutions.length !== 20) {
      throw new Error(`Workspace verification failed after rendering ${title}`);
    }
    const solutionId = workspace.value.solutions[0]?.id;
    const sourceId = workspace.value.problemCandidates[0]?.factors[0]?.sourceId;
    if (!solutionId || !sourceId) throw new Error(`Missing detail IDs after rendering ${title}`);

    const detailResult = await evaluate<{ durationMs: number; mechanism: string; overviewTextBytes: number }>(session.cdp, `(async () => {
      const solution = document.querySelector('details.solution');
      const solutionSummary = solution?.querySelector(':scope > summary');
      const overview = solution?.querySelector('details.category');
      const overviewSummary = overview?.querySelector(':scope > summary');
      if (!(solution instanceof HTMLDetailsElement) || !(solutionSummary instanceof HTMLElement)
        || !(overview instanceof HTMLDetailsElement) || !(overviewSummary instanceof HTMLElement)) {
        throw new Error('Solution detail controls are missing');
      }
      solution.open = false;
      overview.open = false;
      const started = performance.now();
      solutionSummary.click();
      overviewSummary.click();
      const deadline = started + ${READINESS_TIMEOUT_MS};
      while (performance.now() < deadline) {
        const overviewText = overview.querySelector('.overview')?.textContent ?? '';
        if (solution.open && overview.open && overviewText.includes('Synthetic solution analysis')) {
          await new Promise((resolve) => setTimeout(resolve, 0));
          const rendered = overview.querySelector('.overview')?.getBoundingClientRect();
          if (!rendered || rendered.height <= 0) throw new Error('Expanded solution detail has no rendered height');
          return {
            durationMs: performance.now() - started,
            mechanism: solution.querySelector('.identity strong')?.textContent?.trim() ?? '',
            overviewTextBytes: new TextEncoder().encode(overviewText).length,
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error('Rendered solution detail timed out');
    })()`, READINESS_TIMEOUT_MS + 1_000);
    localDetailSamples.push({ sequence: index + 1, sampledAtMs: measurementElapsedMs(), targetTitle: title, ...detailResult });

    const ideaDetail = await detailIpc<JsonObject>(session.cdp, "ideaDetail", solutionId);
    const ideaDescription = ideaDetail.value.description;
    const ideaOutcomes = ideaDetail.value.outcomes;
    const ideaRisks = ideaDetail.value.risks;
    if (
      typeof ideaDescription !== "string"
      || ideaDescription.length !== 8_192
      || !Array.isArray(ideaOutcomes)
      || ideaOutcomes.length !== 3
      || !Array.isArray(ideaRisks)
      || ideaRisks.length !== 3
    ) throw new Error(`Idea detail shape mismatch for ${solutionId}`);
    ideaDetailSamples.push({
      sequence: index + 1,
      sampledAtMs: measurementElapsedMs(),
      durationMs: ideaDetail.durationMs,
      responseBytes: ideaDetail.responseBytes,
      descriptionBytes: new TextEncoder().encode(ideaDescription).length,
      outcomeCount: ideaOutcomes.length,
      riskCount: ideaRisks.length,
      id: solutionId,
    });
    const sourceDetail = await detailIpc<JsonObject>(session.cdp, "sourceDetail", sourceId);
    const sourceText = sourceDetail.value.text;
    if (typeof sourceText !== "string" || sourceText.length !== 16_384) {
      throw new Error(`Source detail shape mismatch for ${sourceId}`);
    }
    sourceDetailSamples.push({
      sequence: index + 1,
      sampledAtMs: measurementElapsedMs(),
      durationMs: sourceDetail.durationMs,
      responseBytes: sourceDetail.responseBytes,
      textBytes: new TextEncoder().encode(sourceText).length,
      id: sourceId,
    });
    if ((index + 1) % 10 === 0) {
      record("switch-detail-progress", { completed: index + 1, total: SWITCH_AND_DETAIL_SAMPLES });
      writeRaw();
    }
  }

  const finalMemory = memorySummary(processMemory(session.process.pid));
  const initialPids = initialMemory.processes.map((process) => `${process.role}:${process.pid}`).sort();
  const finalPids = finalMemory.processes.map((process) => `${process.role}:${process.pid}`).sort();
  const sameProcessRolesAndPids = JSON.stringify(initialPids) === JSON.stringify(finalPids);
  const screenshot = await bounded("final screenshot", 5_000, session.cdp.call("Page.captureScreenshot", {
    format: "png", fromSurface: true, captureBeyondViewport: true,
  })) as { data?: string };
  if (!screenshot.data) throw new Error("CDP returned no final screenshot data");
  const screenshotPath = join(artifactDirectory, "final-synthetic-workspace.png");
  writeFileSync(screenshotPath, Buffer.from(screenshot.data, "base64"));

  const emptyCold = coldSamples.filter((sample) => sample.mode === "empty");
  const syntheticCold = coldSamples.filter((sample) => sample.mode === "synthetic");
  const report = {
    verdict: "pass",
    capturedAt: new Date().toISOString(),
    preparationElapsedMs: measurementStartedAt - runStarted,
    measurementElapsedMs: measurementElapsedMs(),
    totalElapsedMs: elapsedMs(),
    installed: {
      executablePath,
      executableSha256,
      executableBytes: statSync(executablePath).size,
      expectedRendererUrl,
      label,
    },
    fixture,
    samplePlan: {
      emptyColdStarts: COLD_SAMPLES_PER_MODE,
      syntheticColdStarts: COLD_SAMPLES_PER_MODE,
      warmWorkspaceLoads: WARM_WORKSPACE_SAMPLES,
      renderedProjectSwitches: SWITCH_AND_DETAIL_SAMPLES,
      renderedDetailExpansions: SWITCH_AND_DETAIL_SAMPLES,
      ideaDetailIpcCalls: SWITCH_AND_DETAIL_SAMPLES,
      sourceDetailIpcCalls: SWITCH_AND_DETAIL_SAMPLES,
      readinessTimeoutMs: READINESS_TIMEOUT_MS,
    },
    summaries: {
      emptyColdUsableUi: summary(emptyCold.map((sample) => sample.usableUiMs)),
      syntheticColdUsableUi: summary(syntheticCold.map((sample) => sample.usableUiMs)),
      syntheticColdNativeReady: summary(syntheticCold.map((sample) => sample.nativeReadyMs)),
      warmWorkspace: summary(warmWorkspaceSamples.map((sample) => Number(sample.durationMs))),
      renderedProjectSwitch: summary(switchSamples.map((sample) => Number(sample.durationMs))),
      renderedDetailExpansion: summary(localDetailSamples.map((sample) => Number(sample.durationMs))),
      ideaDetailIpc: summary(ideaDetailSamples.map((sample) => Number(sample.durationMs))),
      sourceDetailIpc: summary(sourceDetailSamples.map((sample) => Number(sample.durationMs))),
      workspaceResponseBytes: {
        samples: warmWorkspaceSamples.length,
        min: Math.min(...warmWorkspaceSamples.map((sample) => Number(sample.responseBytes))),
        p50: percentile(warmWorkspaceSamples.map((sample) => Number(sample.responseBytes)), 0.5),
        p95: percentile(warmWorkspaceSamples.map((sample) => Number(sample.responseBytes)), 0.95),
        max: Math.max(...warmWorkspaceSamples.map((sample) => Number(sample.responseBytes))),
      },
    },
    targets: {
      usableUiUnder2Seconds: {
        thresholdMs: UI_TARGET_MS,
        emptyP95Ms: summary(emptyCold.map((sample) => sample.usableUiMs)).p95Ms,
        syntheticP95Ms: summary(syntheticCold.map((sample) => sample.usableUiMs)).p95Ms,
        pass: summary(emptyCold.map((sample) => sample.usableUiMs)).p95Ms < UI_TARGET_MS
          && summary(syntheticCold.map((sample) => sample.usableUiMs)).p95Ms < UI_TARGET_MS,
      },
      warmRenderedInteractionUnder250Ms: {
        thresholdMs: WARM_DETAIL_P95_TARGET_MS,
        projectSwitchP95Ms: summary(switchSamples.map((sample) => Number(sample.durationMs))).p95Ms,
        detailExpansionP95Ms: summary(localDetailSamples.map((sample) => Number(sample.durationMs))).p95Ms,
        pass: summary(switchSamples.map((sample) => Number(sample.durationMs))).p95Ms < WARM_DETAIL_P95_TARGET_MS
          && summary(localDetailSamples.map((sample) => Number(sample.durationMs))).p95Ms < WARM_DETAIL_P95_TARGET_MS,
      },
      warmDetailIpcUnder250Ms: {
        thresholdMs: WARM_DETAIL_P95_TARGET_MS,
        ideaP95Ms: summary(ideaDetailSamples.map((sample) => Number(sample.durationMs))).p95Ms,
        sourceP95Ms: summary(sourceDetailSamples.map((sample) => Number(sample.durationMs))).p95Ms,
        pass: summary(ideaDetailSamples.map((sample) => Number(sample.durationMs))).p95Ms < WARM_DETAIL_P95_TARGET_MS
          && summary(sourceDetailSamples.map((sample) => Number(sample.durationMs))).p95Ms < WARM_DETAIL_P95_TARGET_MS,
      },
    },
    memory: {
      initial: initialMemory,
      final: finalMemory,
      sameProcessRolesAndPids,
      workingSetDeltaBytes: finalMemory.workingSetBytes - initialMemory.workingSetBytes,
      privateDeltaBytes: finalMemory.privateBytes - initialMemory.privateBytes,
    },
    ipc: {
      observedProbeInvocations: ipcObserved,
      selectThreadResponseBytes: {
        status: "unobservable",
        reason: "The production contextBridge API is immutable, so UI-triggered selectThread responses cannot be intercepted without product instrumentation.",
      },
      rendererNetwork: session.network,
      rendererNetworkCoverage: "CDP attached after the renderer target appeared; startup file requests before attachment are not included. Main-process backend HTTP is outside renderer CDP.",
    },
    unobservable: {
      sqliteQueryCounts: "The installed production build exposes no SQLite query counter or trace hook.",
      internalIpcCounts: "Direct probe calls and UI clicks are counted, but production-internal startup/reconciliation IPC is not observable through the immutable contextBridge API.",
      fakeEventLatency: "Not measured: no real or synthetic backend events were injected.",
      providerValidationNetwork: "Renderer CDP cannot observe main-process/backend provider checks; provider credentials were absent and provider calls were not initiated.",
    },
    isolation: {
      syntheticAndRedactedFixture: true,
      actualUserDataAccessed: false,
      secretsCopied: false,
      e2eMode: false,
      backendInjected: false,
      providerLoginAttempted: false,
      providerGenerationAttempted: false,
      paidCallsAttempted: false,
      codexAvailableOnPath: false,
    },
    artifacts: { rawPath, reportPath, eventsPath, screenshotPath },
  };
  writeRaw();
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  record("measurement-passed", { reportPath, measurementElapsedMs: measurementElapsedMs(), targets: report.targets });
  console.log(reportPath);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  writeRaw();
  writeFileSync(reportPath, `${JSON.stringify({
    verdict: "fail",
    capturedAt: new Date().toISOString(),
    elapsedMs: elapsedMs(),
    message,
    installed: { executablePath, executableSha256, label },
    fixture,
    artifacts: { rawPath, reportPath, eventsPath },
  }, null, 2)}\n`, "utf8");
  record("measurement-failed", { message, reportPath });
  throw error;
} finally {
  if (retainedSynthetic) await closeSession(retainedSynthetic).catch((error) => {
    record("retained-session-cleanup-failed", { message: error instanceof Error ? error.message : String(error) });
  });
}
