import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { config } from "./config.js";
import { health } from "./routes/health.js";
import { oauth } from "./routes/oauth.js";

const app = new Hono();

app.route("/", health);
app.route("/", oauth);

app.onError((err, c) => {
  console.error("Unhandled error:", err.message);
  return c.json({ error: "Internal server error" }, 500);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});

serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.log(`Server listening on http://localhost:${info.port}`);
});

export { app };
