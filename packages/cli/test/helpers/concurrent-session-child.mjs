import { SessionManager } from "@hajicli/core";

const [dir, id, content] = process.argv.slice(2);
const warnings = [];
const manager = new SessionManager(dir, (w) => warnings.push(w));
if (!manager.loadSession(id)) throw new Error("cannot load");
process.send({ ready: true });
process.once("message", async () => {
  manager.saveCurrentSession([{ role: "user", content }]);
  await manager.flush();
  process.send({ pending: manager.hasPendingWrites(), warnings });
  process.disconnect();
});
