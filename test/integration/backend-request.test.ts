import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { requestBackend } from "../../src/app/backend-request";

test("a lost backend response never replays an admitted mutation", async () => {
  let admissions = 0;
  const server = createServer((request, response) => {
    if (request.headers.authorization !== "Bearer synthetic") {
      response.writeHead(401).end(); return;
    }
    if (request.url === "/mutate") {
      admissions += 1;
      request.resume();
      request.once("end", () => request.socket.destroy());
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true, data: { admissions } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Synthetic backend failed to bind");
    const ready = { port: address.port, token: "synthetic" };
    await expect(requestBackend(ready, "/mutate", { method: "POST", body: "{}" })).rejects.toMatchObject({ code: "backend_unavailable" });
    expect(await requestBackend(ready, "/state")).toEqual({ admissions: 1 });
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
