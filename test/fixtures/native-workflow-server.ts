import { createInterface } from "node:readline";
import { startNativeWorkflowBackend } from "./native-workflow-backend";

const directory = process.argv[2];
if (!directory) throw new Error("A temporary test directory is required");
const backend = await startNativeWorkflowBackend(directory, {
  onEvent: (event) => { process.stdout.write(`${JSON.stringify({ event })}\n`); },
});
process.stdout.write(`${JSON.stringify({ port: backend.port, token: backend.token })}\n`);
const input = createInterface({ input: process.stdin });
input.once("line", () => { input.close(); });
input.once("close", () => { void backend.close().then(() => process.exit(0)); });
