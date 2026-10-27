// made by namar0x0309 with ❤️ at GoAIX
import { request } from "undici";

export interface WekanLoginResponse {
  id: string;
  token: string;
  tokenExpires: string;
}

export type WekanClientOpts = {
  baseUrl: string;
  token?: string;
  username?: string;
  password?: string;
  userId?: string;
};

// Wekan API response types
export interface WekanBoard {
  _id: string;
  title: string;
  permission?: string;
  labels?: { _id: string; name?: string; color?: string }[];
  members?: { userId: string; isAdmin?: boolean; isActive?: boolean }[];
  [key: string]: any;
}

export interface WekanList {
  _id: string;
  title: string;
  [key: string]: any;
}

export interface WekanSwimlane {
  _id: string;
  title: string;
  [key: string]: any;
}

export interface WekanCard {
  _id: string;
  title: string;
  description?: string;
  boardId?: string;
  listId?: string;
  swimlaneId?: string;
  userId?: string;
  members?: string[];
  assignees?: string[];
  labelIds?: string[];
  dueAt?: string;
  archived?: boolean;
  createdAt?: string;
  modifiedAt?: string;
  [key: string]: any;
}

export interface WekanComment {
  _id: string;
  [key: string]: any;
}

export type CreateCardInput = {
  title: string;
  description?: string | undefined;
  swimlaneId?: string | undefined;
  due?: string | undefined;
  members?: string[] | undefined;
  labels?: string[] | undefined;
};

const TIMEOUT_MS = 30_000;

// Meteor reports many API errors as HTTP 200 with {error, reason, statusCode} in the body
function meteorError(data: any): string | null {
  if (data && typeof data === "object" && !Array.isArray(data) && "error" in data && ("statusCode" in data || "reason" in data)) {
    return `${data.statusCode ?? ""} ${data.reason ?? data.error}`.trim();
  }
  return null;
}

export class Wekan {
  private token: string | null = null;
  private userIdCache: string | null = null;

  constructor(private opts: WekanClientOpts) {
    if (opts.token) this.token = opts.token;
    if (opts.userId) this.userIdCache = opts.userId;
  }

  private async authenticate(): Promise<string> {
    if (this.token) {
      return this.token;
    }

    // If we have username/password, login once and reuse the token
    if (this.opts.username && this.opts.password) {
      const r = await request(`${this.opts.baseUrl}/users/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          username: this.opts.username,
          password: this.opts.password
        }),
        headersTimeout: TIMEOUT_MS,
        bodyTimeout: TIMEOUT_MS
      });
      const loginResponse = await r.body.json().catch(() => null) as WekanLoginResponse | null;

      if (r.statusCode >= 400 || !loginResponse?.token) {
        throw new Error(`Login failed -> ${r.statusCode} ${meteorError(loginResponse) ?? ""}`.trim());
      }

      this.token = loginResponse.token;
      this.userIdCache ??= loginResponse.id;
      return this.token;
    }

    throw new Error("No authentication method provided. Set WEKAN_API_TOKEN or WEKAN_USERNAME/WEKAN_PASSWORD");
  }

  private async headers() {
    const token = await this.authenticate();
    return { Authorization: `Bearer ${token}` };
  }

  private async requestWithAuth(path: string, options: any): Promise<any> {
    const headers = await this.headers();
    const method = options.method || "GET";
    const r = await request(`${this.opts.baseUrl}${path}`, {
      ...options,
      headers: { ...headers, ...options.headers },
      headersTimeout: TIMEOUT_MS,
      bodyTimeout: TIMEOUT_MS
    });
    const text = await r.body.text();

    let data: any;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      // Non-JSON means an HTML error page (500/403/405 or an unknown route)
      const msg = text.match(/<pre>([^<]*)<\/pre>/)?.[1] ?? "non-JSON response";
      throw new Error(`${method} ${path} -> ${r.statusCode} ${msg}`);
    }

    const err = meteorError(data);
    if (r.statusCode >= 400 || err) {
      throw new Error(`${method} ${path} -> ${err ?? r.statusCode}`);
    }

    return data;
  }

  async get(path: string): Promise<any> {
    return this.requestWithAuth(path, { method: "GET" });
  }

  async post(path: string, body: unknown): Promise<any> {
    return this.requestWithAuth(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {})
    });
  }

  async put(path: string, body: unknown): Promise<any> {
    return this.requestWithAuth(path, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {})
    });
  }

  // Wekan requires authorId on cards/comments; take it from the token owner
  async userId(): Promise<string> {
    if (!this.userIdCache) {
      await this.authenticate();
      this.userIdCache ??= (await this.get(`/api/user`))._id;
    }
    return this.userIdCache!;
  }

  private async assertInBoard(boardId: string, listId?: string, swimlaneId?: string) {
    if (listId && !(await this.listLists(boardId)).some((l) => l._id === listId)) {
      throw new Error(`List ${listId} does not belong to board ${boardId}`);
    }
    if (swimlaneId && !(await this.listSwimlanes(boardId)).some((s) => s._id === swimlaneId)) {
      throw new Error(`Swimlane ${swimlaneId} does not belong to board ${boardId}`);
    }
  }

  // API surface
  // GET /api/boards is admin-only (and returns public boards only), so ask for the user's own boards
  async listBoards(): Promise<WekanBoard[]> { return this.get(`/api/users/${await this.userId()}/boards`); }
  getBoard(boardId: string): Promise<WekanBoard> { return this.get(`/api/boards/${boardId}`); }
  listLists(boardId: string): Promise<WekanList[]> { return this.get(`/api/boards/${boardId}/lists`); }
  listSwimlanes(boardId: string): Promise<WekanSwimlane[]> { return this.get(`/api/boards/${boardId}/swimlanes`); }
  listCards(boardId: string, listId: string): Promise<WekanCard[]> { return this.get(`/api/boards/${boardId}/lists/${listId}/cards`); }
  getCard(cardId: string): Promise<WekanCard> { return this.get(`/api/cards/${cardId}`); }

  async createCard(boardId: string, listId: string, input: CreateCardInput): Promise<WekanCard> {
    // swimlaneId is mandatory for Wekan; default to the board's first swimlane
    const swimlaneId = input.swimlaneId ?? (await this.listSwimlanes(boardId))[0]?._id;
    if (!swimlaneId) throw new Error(`Board ${boardId} has no swimlanes`);
    await this.assertInBoard(boardId, listId, input.swimlaneId);
    if (input.members?.length || input.labels?.length) {
      // Wekan 12 logs a non-member in `members` as a security event, and such events disable the account
      const board = await this.getBoard(boardId);
      const memberIds = new Set((board.members ?? []).filter((m) => m.isActive).map((m) => m.userId));
      const labelIds = new Set((board.labels ?? []).map((l) => l._id));
      const strangers = (input.members ?? []).filter((m) => !memberIds.has(m));
      const unknown = (input.labels ?? []).filter((l) => !labelIds.has(l));
      if (strangers.length) throw new Error(`Not active members of board ${boardId}: ${strangers.join(", ")}`);
      if (unknown.length) throw new Error(`Labels not on board ${boardId}: ${unknown.join(", ")}`);
    }

    const body: any = { authorId: await this.userId(), title: input.title, swimlaneId };
    if (input.description) body.description = input.description;
    if (input.members) body.members = input.members;
    const card = await this.post(`/api/boards/${boardId}/lists/${listId}/cards`, body);

    // POST silently ignores dueAt and labelIds; they are only applied via PUT
    const extra: any = {};
    if (input.due) extra.dueAt = input.due;
    if (input.labels) extra.labelIds = input.labels;
    if (Object.keys(extra).length) await this.put(`/api/boards/${boardId}/lists/${listId}/cards/${card._id}`, extra);

    return { ...card, title: input.title, listId, swimlaneId };
  }

  async moveCard(boardId: string, cardId: string, body: { listId?: string; swimlaneId?: string }): Promise<WekanCard> {
    if (!body.listId && !body.swimlaneId) throw new Error("Pass listId and/or swimlaneId");
    // The update route needs the card's current list
    const card = await this.getCard(cardId);
    if (card.boardId !== boardId) throw new Error(`Card ${cardId} is not on board ${boardId}`);
    await this.assertInBoard(boardId, body.listId, body.swimlaneId);
    await this.put(`/api/boards/${boardId}/lists/${card.listId}/cards/${cardId}`, body);
    return this.getCard(cardId);
  }

  async commentCard(boardId: string, cardId: string, text: string): Promise<WekanComment> {
    // A card/board mismatch is a CWE-639 event in Wekan 12 and disables the account, so check it here
    const card = await this.getCard(cardId);
    if (card.boardId !== boardId) throw new Error(`Card ${cardId} is not on board ${boardId}`);
    return this.post(`/api/boards/${boardId}/cards/${cardId}/comments`, { authorId: await this.userId(), comment: text });
  }
}
