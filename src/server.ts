// made by namar0x0309 with ❤️ at GoAIX
import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Wekan } from "./wekan.js";

// Read .env next to the package, not from the client's cwd; quiet keeps stdout clean for JSON-RPC
config({ path: fileURLToPath(new URL("../.env", import.meta.url)), quiet: true });

const BASE_URL = process.env["WEKAN_BASE_URL"]?.replace(/\/$/, "") || "";
const TOKEN = process.env["WEKAN_API_TOKEN"] || "";
const USERNAME = process.env["WEKAN_USERNAME"] || "";
const PASSWORD = process.env["WEKAN_PASSWORD"] || "";
const USER_ID = process.env["WEKAN_USER_ID"] || "";

if (!BASE_URL || (!TOKEN && !(USERNAME && PASSWORD))) {
  // Fail fast so agent surfaces a clear error.
  throw new Error("Set WEKAN_BASE_URL and either WEKAN_API_TOKEN or both WEKAN_USERNAME and WEKAN_PASSWORD");
}

const wekan = new Wekan({
  baseUrl: BASE_URL,
  token: TOKEN,
  username: USERNAME,
  password: PASSWORD,
  userId: USER_ID
});

const server = new McpServer(
  { name: "mcp-wekan", version: "0.2.0" },
  { capabilities: { tools: {} } }
);

// Ids go into URL paths, so allow only Meteor-style ids (no "/", "?", "..")
const id = () => z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "invalid Wekan id");

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });

// Register tools
server.tool("listBoards", "List boards the current user is a member of", {}, async () => {
  const boards = await wekan.listBoards();
  // Return trimmed, agent-friendly fields
  return json(boards.map((b) => ({ id: b._id, title: b.title })));
});

server.tool("getBoard", "Get board details: labels (ids for createCard) and members (user ids)", {
  boardId: id()
}, async (args) => {
  const b = await wekan.getBoard(args.boardId);
  return json({
    id: b._id,
    title: b.title,
    permission: b.permission,
    labels: (b.labels ?? []).map((l) => ({ id: l._id, name: l.name, color: l.color })),
    members: (b.members ?? []).filter((m) => m.isActive).map((m) => ({ userId: m.userId, isAdmin: m.isAdmin }))
  });
});

server.tool("listLists", "List lists in a board", {
  boardId: id()
}, async (args) => {
  const { boardId } = args;
  const lists = await wekan.listLists(boardId);
  return json(lists.map((l) => ({ id: l._id, title: l.title })));
});

server.tool("listSwimlanes", "List swimlanes in a board", {
  boardId: id()
}, async (args) => {
  const { boardId } = args;
  const lanes = await wekan.listSwimlanes(boardId);
  return json(lanes.map((s) => ({ id: s._id, title: s.title })));
});

server.tool("listCards", "List cards in a board+list", {
  boardId: id(),
  listId: id()
}, async (args) => {
  const { boardId, listId } = args;
  const cards = await wekan.listCards(boardId, listId);
  return json(cards.map((c) => ({ id: c._id, title: c.title, desc: c.description, swimlaneId: c.swimlaneId })));
});

server.tool("getCard", "Get full card details by id", {
  cardId: id()
}, async (args) => {
  const c = await wekan.getCard(args.cardId);
  return json({
    id: c._id, title: c.title, description: c.description, boardId: c.boardId, listId: c.listId,
    swimlaneId: c.swimlaneId, authorId: c.userId, members: c.members, assignees: c.assignees,
    labelIds: c.labelIds, dueAt: c.dueAt, archived: c.archived, createdAt: c.createdAt, modifiedAt: c.modifiedAt
  });
});

server.tool("createCard", "Create a card (author = current user). swimlaneId defaults to the board's first swimlane", {
  boardId: id(),
  listId: id(),
  title: z.string().min(1),
  description: z.string().optional(),
  swimlaneId: id().optional(),
  due: z.iso.datetime().optional(),
  members: z.array(id()).optional(),
  labels: z.array(id()).optional().describe("label ids from getBoard")
}, async (args) => {
  const { boardId, listId, ...input } = args;
  const card = await wekan.createCard(boardId, listId, input);
  return json({ id: card._id, title: card.title, listId: card.listId, swimlaneId: card.swimlaneId });
});

server.tool("moveCard", "Move a card to another list and/or swimlane on the same board", {
  boardId: id(),
  cardId: id(),
  listId: id().optional(),
  swimlaneId: id().optional()
}, async (args) => {
  const { boardId, cardId, listId, swimlaneId } = args;
  const payload: any = {};
  if (listId) payload.listId = listId;
  if (swimlaneId) payload.swimlaneId = swimlaneId;
  const card = await wekan.moveCard(boardId, cardId, payload);
  return json({ id: card._id, listId: card.listId, swimlaneId: card.swimlaneId });
});

server.tool("commentCard", "Add a comment to a card (author = current user)", {
  boardId: id(),
  cardId: id(),
  text: z.string().min(1)
}, async (args) => {
  const { boardId, cardId, text } = args;
  const res = await wekan.commentCard(boardId, cardId, text);
  return json({ ok: true, commentId: res._id });
});

// Start transport
const transport = new StdioServerTransport();
await server.connect(transport);
