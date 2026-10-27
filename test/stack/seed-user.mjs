// Creates a test user through the sign-up method the Wekan web form uses (REST has no sign-up).
// Usage: node test/stack/seed-user.mjs http://127.0.0.1:8091 <username> <password>
// The welcome-mail step fails without MAIL_URL (500), but the user is still created.
import { createHash } from "node:crypto";
const [,, url, username, password] = process.argv;
const ws = new WebSocket(url.replace(/^http/, "ws") + "/websocket");
const send = (m) => ws.send(JSON.stringify(m));
ws.onopen = () => send({ msg: "connect", version: "1", support: ["1"] });
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.msg === "ping") return send({ msg: "pong" });
  if (m.msg === "connected") {
    const digest = createHash("sha256").update(password).digest("hex");
    send({ msg: "method", id: "1", method: process.env.M || "ATCreateUserServer",
      params: [{ username, email: `${username}@test.local`, password: { digest, algorithm: "sha-256" }, profile: {} }] });
  }
  if (m.msg === "result") { console.log(username, m.error ? m.error.reason : "created"); ws.close(); process.exit(0); }
};
setTimeout(() => { console.log("timeout"); process.exit(1); }, 15000);
