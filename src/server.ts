import { createServer } from "node:http";

const rawPort = process.env.PORT ?? "3100";
if (!/^\d+$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535)
  throw new Error("PORT must be an integer between 1 and 65535");
const server = createServer((request, response) => {
  const healthy = request.method === "GET" && request.url === "/health";
  response.writeHead(healthy ? 200 : 404, {
    "content-type": "application/json",
  });
  response.end(
    JSON.stringify(healthy ? { status: "ok" } : { error: "Not found" }),
  );
});
server.listen(Number(rawPort), "127.0.0.1", () =>
  console.log(`Agents listening on 127.0.0.1:${rawPort}`),
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => server.close());
