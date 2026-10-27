// End-to-end test: spawns dist/server.js over stdio as a real MCP client and
// checks every tool against a disposable Wekan instance (NOT production).
//
// Env: WEKAN_TEST_URL (default http://127.0.0.1:8091) and three existing users
// admin / andy / outsider with password "Passw0rd!<username>".
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const BASE = (process.env.WEKAN_TEST_URL || "http://127.0.0.1:8091").replace(/\/$/, "");
const pw = (u) => `Passw0rd!${u}`;

let failures = 0;
const check = (name, ok, extra = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  -- " + extra : ""}`);
};

async function rest(token, method, path, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  try { return JSON.parse(text); } catch { return text; }
}

async function login(u) {
  const r = await fetch(BASE + "/users/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: u, password: pw(u) }),
  });
  return r.json(); // { id, token }
}

// ---------- fixtures (fresh per run) ----------
const [admin, andy, outsider] = await Promise.all(["admin", "andy", "outsider"].map(login));
const tag = Date.now().toString(36);

const board = await rest(admin.token, "POST", "/api/boards", { title: `Proteus-${tag}`, owner: admin.id, permission: "private" });
await rest(admin.token, "POST", `/api/boards/${board._id}/members/${andy.id}/add`, { action: "add", isAdmin: false, isNoComments: false, isCommentOnly: false });
const lTodo = (await rest(admin.token, "POST", `/api/boards/${board._id}/lists`, { title: "To Do" }))._id;
const lDoing = (await rest(admin.token, "POST", `/api/boards/${board._id}/lists`, { title: "In Progress" }))._id;
const lane2 = (await rest(admin.token, "POST", `/api/boards/${board._id}/swimlanes`, { title: "Lane 2" }))._id;
const label = await rest(admin.token, "PUT", `/api/boards/${board._id}/labels`, { label: { color: "red", name: "DevSecOps" } });

const secret = await rest(outsider.token, "POST", "/api/boards", { title: `Secret-${tag}`, owner: outsider.id, permission: "private" });
const sList = (await rest(outsider.token, "POST", `/api/boards/${secret._id}/lists`, { title: "s" }))._id;
const sCard = (await rest(outsider.token, "POST", `/api/boards/${secret._id}/lists/${sList}/cards`, { title: "SECRET", swimlaneId: secret.defaultSwimlaneId, authorId: outsider.id }))._id;

// ---------- MCP client helpers ----------
async function startServer(env) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [new URL("../dist/server.js", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")],
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot ?? "", ...env },
    stderr: "pipe",
  });
  const client = new Client({ name: "e2e", version: "0" });
  await client.connect(transport);
  return client;
}

async function call(client, name, args = {}) {
  try {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content?.map((c) => c.text).join("\n") ?? "";
    let data; try { data = JSON.parse(text); } catch { data = undefined; }
    return { isError: !!r.isError, text, data };
  } catch (e) {
    return { isError: true, text: String(e?.message ?? e), data: undefined, protocolError: true };
  }
}

// ---------- token mode, regular (non-admin) member ----------
const c = await startServer({ WEKAN_BASE_URL: BASE, WEKAN_API_TOKEN: andy.token });

const tools = (await c.listTools()).tools.map((t) => t.name).sort();
console.log("tools:", tools.join(", "));

let r = await call(c, "listBoards");
const boardIds = (r.data ?? []).map((b) => b.id);
check("listBoards: works for non-admin", !r.isError && Array.isArray(r.data), r.text.slice(0, 120));
check("listBoards: sees shared board", boardIds.includes(board._id));
check("listBoards: does not leak foreign private board", !boardIds.includes(secret._id));

r = await call(c, "listLists", { boardId: board._id });
check("listLists", !r.isError && r.data?.some((l) => l.id === lTodo) && r.data?.some((l) => l.id === lDoing), r.text.slice(0, 120));

r = await call(c, "listSwimlanes", { boardId: board._id });
check("listSwimlanes", !r.isError && r.data?.some((s) => s.id === board.defaultSwimlaneId) && r.data?.some((s) => s.id === lane2), r.text.slice(0, 120));

if (tools.includes("getBoard")) {
  r = await call(c, "getBoard", { boardId: board._id });
  check("getBoard: returns labels and members", !r.isError && r.data?.labels?.some((l) => l.id === label) && r.data?.members?.some((m) => m.userId === andy.id), r.text.slice(0, 160));
}

// createCard with every optional field except swimlane (must fall back to default swimlane)
const due = "2026-11-05T09:00:00.000Z";
r = await call(c, "createCard", { boardId: board._id, listId: lTodo, title: "Расчёт мощностей", description: "desc ✓", due, labels: [label], members: [andy.id] });
const cardId = r.data?.id;
check("createCard: without swimlaneId", !r.isError && !!cardId, r.text.slice(0, 160));
if (cardId) {
  const card = await rest(andy.token, "GET", `/api/cards/${cardId}`);
  check("createCard: title/description (UTF-8) stored", card.title === "Расчёт мощностей" && card.description === "desc ✓");
  check("createCard: author is token owner", card.userId === andy.id, `userId=${card.userId}`);
  check("createCard: default swimlane", card.swimlaneId === board.defaultSwimlaneId, `swimlaneId=${card.swimlaneId}`);
  check("createCard: due stored", card.dueAt === due, `dueAt=${card.dueAt}`);
  check("createCard: labels stored", JSON.stringify(card.labelIds) === JSON.stringify([label]), `labelIds=${JSON.stringify(card.labelIds)}`);
  check("createCard: members stored", JSON.stringify(card.members) === JSON.stringify([andy.id]), `members=${JSON.stringify(card.members)}`);
}

r = await call(c, "createCard", { boardId: board._id, listId: lTodo, title: "in lane 2", swimlaneId: lane2 });
check("createCard: explicit swimlaneId", !r.isError && r.data?.id, r.text.slice(0, 160));

r = await call(c, "listCards", { boardId: board._id, listId: lTodo });
check("listCards", !r.isError && r.data?.some((x) => x.id === cardId), r.text.slice(0, 120));

if (tools.includes("getCard") && cardId) {
  r = await call(c, "getCard", { cardId });
  check("getCard", !r.isError && r.data?.id === cardId && r.data?.listId === lTodo && r.data?.dueAt === due, r.text.slice(0, 160));
}

if (cardId) {
  r = await call(c, "moveCard", { boardId: board._id, cardId, listId: lDoing });
  let card = await rest(andy.token, "GET", `/api/cards/${cardId}`);
  check("moveCard: to another list", !r.isError && card.listId === lDoing, `${r.text.slice(0, 120)} listId=${card.listId}`);

  r = await call(c, "moveCard", { boardId: board._id, cardId, swimlaneId: lane2 });
  card = await rest(andy.token, "GET", `/api/cards/${cardId}`);
  check("moveCard: to another swimlane", !r.isError && card.swimlaneId === lane2 && card.listId === lDoing, `${r.text.slice(0, 120)} swimlane=${card.swimlaneId}`);

  r = await call(c, "moveCard", { boardId: board._id, cardId, listId: sList });
  card = await rest(andy.token, "GET", `/api/cards/${cardId}`);
  check("moveCard: refuses list from another board", r.isError && card.listId === lDoing, r.text.slice(0, 120));

  r = await call(c, "commentCard", { boardId: board._id, cardId, text: "комментарий от MCP" });
  const comments = await rest(andy.token, "GET", `/api/boards/${board._id}/cards/${cardId}/comments`);
  check("commentCard", !r.isError && Array.isArray(comments) && comments.some((m) => m.comment === "комментарий от MCP" && m.authorId === andy.id), r.text.slice(0, 120));
}

// ---------- negative paths: must be clean tool errors, server must survive ----------
r = await call(c, "listLists", { boardId: secret._id });
check("foreign board -> tool error (not silent [])", r.isError && /forbidden|403/i.test(r.text), r.text.slice(0, 120));

r = await call(c, "createCard", { boardId: secret._id, listId: sList, title: "hack" });
check("createCard on foreign board -> error", r.isError, r.text.slice(0, 120));

r = await call(c, "moveCard", { boardId: board._id, cardId: sCard, listId: lTodo });
const sc = await rest(outsider.token, "GET", `/api/cards/${sCard}`);
check("moveCard foreign card -> error, card untouched", r.isError && sc.listId === sList, r.text.slice(0, 120));

r = await call(c, "listLists", { boardId: "../../api/user" });
check("path traversal in id rejected", r.isError, r.text.slice(0, 120));

r = await call(c, "listBoards");
check("server alive after errors", !r.isError, r.text.slice(0, 80));
await c.close();

// ---------- username/password mode ----------
const cp = await startServer({ WEKAN_BASE_URL: BASE, WEKAN_USERNAME: "andy", WEKAN_PASSWORD: pw("andy") });
r = await call(cp, "listBoards");
check("password mode: listBoards", !r.isError && (r.data ?? []).some((b) => b.id === board._id), r.text.slice(0, 120));
r = await call(cp, "commentCard", { boardId: board._id, cardId: cardId ?? "x", text: "pw mode" });
check("password mode: commentCard", !r.isError, r.text.slice(0, 120));
await cp.close();

// ---------- bad token ----------
const cb = await startServer({ WEKAN_BASE_URL: BASE, WEKAN_API_TOKEN: "definitely-not-a-token" });
r = await call(cb, "listBoards");
check("bad token -> clear error", r.isError && /unauthor|401/i.test(r.text), r.text.slice(0, 120));
await cb.close();

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
