import { createApp } from "./app.js";

const port = Number.parseInt(process.env.PORT ?? "8000", 10);
const host = process.env.HOST ?? "0.0.0.0";

createApp().listen(port, host, () => {
  process.stdout.write(`service listening on ${host}:${port}\n`);
});
