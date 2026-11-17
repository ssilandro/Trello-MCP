import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test, beforeEach, afterEach } from "node:test";
import { webcrypto } from "node:crypto";

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const source = await readFile(new URL("../worker.js", import.meta.url), "utf8");
const { default: worker } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
const CLIENT_ID = "https://chatgpt.com/oauth/client.json";
const REDIRECT_URI = "https://chatgpt.com/connector_platform_oauth_redirect";
const BASE = "https://trello-mcp.example";
const PASSWORD = "senha-segura-de-teste-2026";
const OAUTH_SECRET = "test-secret-that-is-at-least-32-characters-long";
const TRELLO_KEY = "mock-key";
const TRELLO_TOKEN = "mock-token";

const originalFetch = globalThis.fetch;
let fixture;
let trelloCalls;

function asResponse(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

class MockStatement {
  constructor(database, sql) {
    this.database = database;
    this.sql = sql;
    this.values = [];
  }

  bind(...values) {
    this.values = values;
    return this;
  }

  async run() {
    return this.database.execute(this);
  }

  async first() {
    const result = await this.database.execute(this);
    return result.results?.[0] || null;
  }
}

class MockD1 {
  constructor() {
    this.codes = new Map();
    this.rates = new Map();
  }

  prepare(sql) {
    return new MockStatement(this, sql);
  }

  async batch(statements) {
    const results = [];
    for (const statement of statements) results.push(await this.execute(statement));
    return results;
  }

  async execute(statement) {
    const sql = statement.sql.replace(/\s+/g, " ").trim();
    const values = statement.values;
    if (/^CREATE (TABLE|INDEX)/i.test(sql)) return { success: true, results: [], meta: { changes: 0 } };

    if (sql.startsWith("DELETE FROM oauth_codes WHERE expires_at <=")) {
      const [now] = values;
      for (const [code, row] of this.codes) if (row.expiresAt <= now) this.codes.delete(code);
      return { success: true, results: [], meta: { changes: 0 } };
    }
    if (sql.startsWith("DELETE FROM oauth_rate_limits WHERE expires_at <=")) {
      const [now] = values;
      for (const [ip, row] of this.rates) if (row.expiresAt <= now) this.rates.delete(ip);
      return { success: true, results: [], meta: { changes: 0 } };
    }
    if (sql.startsWith("INSERT INTO oauth_rate_limits")) {
      const [ipHash, nextExpiry, resetCheckA, resetCheckB, resetExpiry, resetCheckC, max] = values;
      const existing = this.rates.get(ipHash);
      if (!existing || existing.expiresAt <= resetCheckA) {
        this.rates.set(ipHash, { count: 1, expiresAt: nextExpiry });
        return { success: true, results: [], meta: { changes: 1 } };
      }
      if (existing.count >= max) return { success: true, results: [], meta: { changes: 0 } };
      existing.count += 1;
      if (existing.expiresAt <= resetCheckB || existing.expiresAt <= resetCheckC) existing.expiresAt = resetExpiry;
      return { success: true, results: [], meta: { changes: 1 } };
    }
    if (sql.startsWith("INSERT INTO oauth_codes")) {
      const [code, flowId, codeChallenge, payload, expiresAt] = values;
      this.codes.set(code, { flowId, codeChallenge, payload, approved: 0, attempts: 0, expiresAt });
      return { success: true, results: [], meta: { changes: 1 } };
    }
    if (sql.startsWith("SELECT payload FROM oauth_codes")) {
      const [flowId, now] = values;
      const row = [...this.codes.values()].find((item) => item.flowId === flowId && item.approved === 0 && item.expiresAt > now);
      return { success: true, results: row ? [{ payload: row.payload }] : [], meta: { changes: 0 } };
    }
    if (sql.startsWith("UPDATE oauth_codes SET approved = 1")) {
      const [expiresAt, payloadExpiry, flowId, now] = values;
      const entry = [...this.codes.entries()].find(([, row]) => row.flowId === flowId && row.approved === 0 && row.expiresAt > now);
      if (!entry) return { success: true, results: [], meta: { changes: 0 } };
      const [code, row] = entry;
      const payload = JSON.parse(row.payload);
      payload.expiresAt = payloadExpiry;
      row.payload = JSON.stringify(payload);
      row.expiresAt = expiresAt;
      row.approved = 1;
      this.codes.set(code, row);
      return { success: true, results: [{ payload: row.payload }], meta: { changes: 1 } };
    }
    if (sql.startsWith("UPDATE oauth_codes SET attempts = attempts + 1")) {
      const [limit, nowExpiry, flowId, now] = values;
      const entry = [...this.codes.entries()].find(([, row]) => row.flowId === flowId && row.approved === 0 && row.expiresAt > now);
      if (!entry) return { success: true, results: [], meta: { changes: 0 } };
      const [code, row] = entry;
      row.attempts += 1;
      if (row.attempts >= limit) row.expiresAt = nowExpiry;
      this.codes.set(code, row);
      return { success: true, results: [{ attempts: row.attempts }], meta: { changes: 1 } };
    }
    if (sql.startsWith("DELETE FROM oauth_codes WHERE code =")) {
      const [code, challenge, now, clientId, redirectUri, resource] = values;
      const row = this.codes.get(code);
      const payload = row ? JSON.parse(row.payload) : null;
      const matches = row && row.codeChallenge === challenge && row.approved === 1 && row.expiresAt > now &&
        payload.clientId === clientId && payload.redirectUri === redirectUri && payload.resource === resource;
      if (!matches) return { success: true, results: [], meta: { changes: 0 } };
      this.codes.delete(code);
      return { success: true, results: [{ payload: row.payload }], meta: { changes: 1 } };
    }
    throw new Error(`SQL não previsto no mock: ${sql}`);
  }
}

function makeEnv(overrides = {}) {
  return {
    TRELLO_KEY,
    TRELLO_TOKEN,
    MCP_LOGIN_PASSWORD: PASSWORD,
    MCP_OAUTH_SECRET: OAUTH_SECRET,
    AUTH_DB: new MockD1(),
    ...overrides,
  };
}

function jsonRpc(method, params = {}, id = 1) {
  return { jsonrpc: "2.0", id, method, params };
}

async function postMcp(env, message, token = null, headers = {}) {
  const requestHeaders = {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    "MCP-Protocol-Version": "2025-11-25",
    ...headers,
  };
  if (token) requestHeaders.Authorization = `Bearer ${token}`;
  return worker.fetch(new Request(`${BASE}/mcp`, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify(message),
  }), env);
}

function randomVerifier() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function challengeFor(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function authorize(env, { password = PASSWORD, resource = BASE, scope = "trello.read" } = {}) {
  const verifier = randomVerifier();
  const challenge = await challengeFor(verifier);
  const state = "state_for_test_0123456789";
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope,
    state,
    resource,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  const loginPage = await worker.fetch(new Request(`${BASE}/authorize?${params}`), env);
  if (loginPage.status !== 200) return { loginPage };
  const html = await loginPage.text();
  const flowId = /name="flow" value="([A-Za-z0-9_-]+)"/.exec(html)?.[1];
  assert.ok(flowId, "OAuth login form should contain a temporary flow ID");
  const form = new URLSearchParams({ flow: flowId, password });
  const approval = await worker.fetch(new Request(`${BASE}/authorize`, {
    method: "POST",
    headers: { Origin: BASE, "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  }), env);
  if (approval.status !== 302) return { loginPage, approval };
  const redirect = new URL(approval.headers.get("Location"));
  const tokenResponse = await worker.fetch(new Request(`${BASE}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: redirect.searchParams.get("code"),
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      resource,
      code_verifier: verifier,
    }).toString(),
  }), env);
  return { loginPage, approval, redirect, tokenResponse, tokenBody: await tokenResponse.json(), verifier };
}

function clientMetadataResponse() {
  return asResponse({
    client_id: CLIENT_ID,
    client_name: "ChatGPT",
    redirect_uris: [REDIRECT_URI],
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  });
}

function jpgBytes() {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0xff, 0xd9]);
}

function pngBytes() {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
}

function attachment(id, name, mimeType, bytes, extra = {}) {
  return {
    id,
    name,
    mimeType,
    bytes: bytes?.byteLength ?? 0,
    date: "2026-11-16T12:00:00.000Z",
    isUpload: true,
    ...extra,
  };
}

function setupFetch() {
  trelloCalls = [];
  fixture = {
    boards: [{ id: "board-1", name: "SB Odonto Clinic", closed: false, url: "https://trello.com/b/board-1" }],
    cards: [{ id: "card-1", name: "Fechamento de caixa", desc: "Fechamento de novembro", idBoard: "board-1", url: "https://trello.com/c/card-1" }],
    attachments: new Map(),
    downloads: new Map(),
    s3Download: null,
    externalCalls: [],
    failures: new Map(),
    invalidTrelloCredentials: false,
  };

  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.hostname === "chatgpt.com") return clientMetadataResponse();
    if (url.hostname === "trello-attachments.s3.amazonaws.com") {
      fixture.externalCalls.push({ url: url.href, init });
      const download = fixture.s3Download;
      return download
        ? new Response(download.bytes, { status: 200, headers: { "Content-Type": download.mimeType, "Content-Length": String(download.bytes.byteLength) } })
        : asResponse({ message: "not found" }, 404);
    }
    if (url.hostname !== "api.trello.com") throw new Error(`Host não esperado no mock: ${url.hostname}`);
    trelloCalls.push({ url: url.href, init });
    const headers = new Headers(init.headers || {});
    if (fixture.invalidTrelloCredentials || headers.get("Authorization") !== `OAuth oauth_consumer_key="${TRELLO_KEY}", oauth_token="${TRELLO_TOKEN}"`) {
      return asResponse({ message: "invalid token" }, 401);
    }
    const failure = fixture.failures.get(url.pathname);
    if (failure) return asResponse({ message: "simulated failure" }, failure);

    if (url.pathname === "/1/members/me/boards") return asResponse(fixture.boards);
    if (url.pathname === "/1/search") return asResponse({ cards: fixture.cards });
    const listMatch = /^\/1\/cards\/([^/]+)\/attachments$/.exec(url.pathname);
    if (listMatch) {
      const cardId = decodeURIComponent(listMatch[1]);
      if (cardId !== "card-1") return asResponse({ message: "not found" }, 404);
      return asResponse([...(fixture.attachments.get(cardId)?.values() || [])]);
    }
    const metadataMatch = /^\/1\/cards\/([^/]+)\/attachments\/([^/]+)$/.exec(url.pathname);
    if (metadataMatch) {
      const cardId = decodeURIComponent(metadataMatch[1]);
      const attachmentId = decodeURIComponent(metadataMatch[2]);
      const value = fixture.attachments.get(cardId)?.get(attachmentId);
      return value ? asResponse(value) : asResponse({ message: "not found" }, 404);
    }
    const downloadMatch = /^\/1\/cards\/([^/]+)\/attachments\/([^/]+)\/download\//.exec(url.pathname);
    if (downloadMatch) {
      const attachmentId = decodeURIComponent(downloadMatch[2]);
      const download = fixture.downloads.get(attachmentId);
      if (!download) return asResponse({ message: "not found" }, 404);
      if (download.redirect) {
        fixture.s3Download = download;
        return new Response(null, { status: 302, headers: { Location: download.redirect } });
      }
      return new Response(download.bytes, { status: 200, headers: { "Content-Type": download.mimeType, "Content-Length": String(download.bytes.byteLength) } });
    }
    throw new Error(`Caminho Trello não previsto no mock: ${url.pathname}`);
  };
}

beforeEach(() => setupFetch());
afterEach(() => { globalThis.fetch = originalFetch; });

test("expõe metadados de recurso e inicializa MCP com a versão negociada", async () => {
  const env = makeEnv();
  const metadata = await worker.fetch(new Request(`${BASE}/.well-known/oauth-protected-resource/mcp`), env);
  assert.equal(metadata.status, 200);
  assert.deepEqual((await metadata.json()).authorization_servers, [BASE]);

  const response = await postMcp(env, jsonRpc("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "ChatGPT", version: "test" },
  }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("MCP-Protocol-Version"), "2025-11-25");
  const body = await response.json();
  assert.equal(body.result.protocolVersion, "2025-11-25");
  assert.equal(body.result.serverInfo.name, "trello-attachment-mcp");
});

test("lista quatro ferramentas OAuth sem expor dados do Trello", async () => {
  const response = await postMcp(makeEnv(), jsonRpc("tools/list"));
  assert.equal(response.status, 200);
  const { result } = await response.json();
  assert.deepEqual(result.tools.map((tool) => tool.name), ["listar_boards", "buscar_cards", "listar_anexos", "ler_anexo"]);
  assert.ok(result.tools.every((tool) => tool._meta.securitySchemes[0].type === "oauth2"));
  assert.equal(trelloCalls.length, 0);
});

test("OAuth rejeita acesso sem token, com token inválido e com Origin não permitido", async () => {
  const env = makeEnv();
  const noToken = await postMcp(env, jsonRpc("tools/call", { name: "listar_boards", arguments: {} }));
  const noTokenBody = await noToken.json();
  assert.equal(noToken.status, 200);
  assert.equal(noTokenBody.result.isError, true);
  assert.match(noTokenBody.result._meta["mcp/www_authenticate"][0], /resource_metadata=/);
  assert.equal(trelloCalls.length, 0);

  const badToken = await postMcp(env, jsonRpc("tools/call", { name: "listar_boards", arguments: {} }), "invalid.token.value");
  assert.equal((await badToken.json()).result.isError, true);
  assert.equal(trelloCalls.length, 0);

  const badOrigin = await postMcp(env, jsonRpc("tools/list"), null, { Origin: "https://attacker.example" });
  assert.equal(badOrigin.status, 403);
});

test("implementa authorization code OAuth com PKCE S256, state, resource e uso único", async () => {
  const env = makeEnv();
  const result = await authorize(env);
  assert.equal(result.loginPage.status, 200);
  assert.equal(result.approval.status, 302);
  assert.equal(result.redirect.searchParams.get("state"), "state_for_test_0123456789");
  assert.equal(result.redirect.searchParams.get("iss"), BASE);
  assert.equal(result.tokenResponse.status, 200);
  assert.equal(result.tokenBody.token_type, "Bearer");
  assert.equal(result.tokenBody.scope, "trello.read");
  assert.ok(result.tokenBody.access_token);

  const reused = await worker.fetch(new Request(`${BASE}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: result.redirect.searchParams.get("code"),
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      resource: BASE,
      code_verifier: result.verifier,
    }).toString(),
  }), env);
  assert.equal(reused.status, 400);
  assert.equal((await reused.json()).error, "invalid_grant");
});

test("rejeita senha OAuth inválida sem autorizar", async () => {
  const env = makeEnv();
  const result = await authorize(env, { password: "senha-incorreta-000000" });
  assert.equal(result.approval.status, 200);
  assert.match(await result.approval.text(), /Senha incorreta/);
  assert.equal(result.tokenResponse, undefined);
});

test("limita tentativas de senha dentro do mesmo fluxo OAuth", async () => {
  const env = makeEnv();
  const verifier = randomVerifier();
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: "trello.read",
    state: "state_for_test_0123456789",
    resource: BASE,
    code_challenge: await challengeFor(verifier),
    code_challenge_method: "S256",
  });
  const page = await worker.fetch(new Request(`${BASE}/authorize?${params}`), env);
  const flowId = /name="flow" value="([A-Za-z0-9_-]+)"/.exec(await page.text())?.[1];
  assert.ok(flowId);

  let lastResponse;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    lastResponse = await worker.fetch(new Request(`${BASE}/authorize`, {
      method: "POST",
      headers: { Origin: BASE, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ flow: flowId, password: "senha-errada" }).toString(),
    }), env);
  }
  assert.equal(lastResponse.status, 429);
  assert.match(await lastResponse.text(), /limite de tentativas/);
});

test("resolve credenciais em bindings do Cloudflare Secrets Store via get()", async () => {
  const values = {
    TRELLO_KEY,
    TRELLO_TOKEN,
    MCP_LOGIN_PASSWORD: PASSWORD,
    MCP_OAUTH_SECRET: OAUTH_SECRET,
  };
  const reads = Object.fromEntries(Object.keys(values).map((name) => [name, 0]));
  const storeBindings = Object.fromEntries(Object.entries(values).map(([name, value]) => [name, {
    async get() {
      reads[name] += 1;
      return value;
    },
  }]));
  const env = makeEnv(storeBindings);
  const auth = await authorize(env);
  assert.equal(auth.tokenResponse.status, 200);

  const response = await postMcp(env, jsonRpc("tools/call", {
    name: "listar_boards",
    arguments: {},
  }), auth.tokenBody.access_token);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).result.structuredContent.boards, [
    { id: "board-1", nome: "SB Odonto Clinic", fechado: false, url: "https://trello.com/b/board-1" },
  ]);
  assert.ok(Object.values(reads).every((count) => count > 0));
});

test("lista boards autenticados pelo Trello", async () => {
  const env = makeEnv();
  const { tokenBody } = await authorize(env);
  const response = await postMcp(env, jsonRpc("tools/call", { name: "listar_boards", arguments: {} }), tokenBody.access_token);
  const result = (await response.json()).result;
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /SB Odonto Clinic/);
  assert.match(trelloCalls[0].init.headers.Authorization, /^OAuth oauth_consumer_key=/);
});

test("busca cards por nome e filtra por board", async () => {
  const env = makeEnv();
  const { tokenBody } = await authorize(env);
  const response = await postMcp(env, jsonRpc("tools/call", {
    name: "buscar_cards",
    arguments: { termo: "Fechamento de caixa", board: "SB Odonto Clinic", limite: 10 },
  }), tokenBody.access_token);
  const result = (await response.json()).result;
  assert.match(result.content[0].text, /Fechamento de caixa/);
  const search = new URL(trelloCalls.at(-1).url);
  assert.equal(search.searchParams.get("idBoards"), "board-1");
  assert.equal(search.searchParams.get("query"), "Fechamento de caixa");
});

test("lista metadados de anexos sem revelar URL assinada", async () => {
  const env = makeEnv();
  const { tokenBody } = await authorize(env);
  const file = attachment("att-jpg", "foto.jpg", "image/jpeg", jpgBytes(), { url: "https://private.example/signed" });
  fixture.attachments.set("card-1", new Map([[file.id, file]]));
  const response = await postMcp(env, jsonRpc("tools/call", {
    name: "listar_anexos",
    arguments: { card_id: "card-1" },
  }), tokenBody.access_token);
  const result = (await response.json()).result;
  assert.match(result.content[0].text, /foto.jpg/);
  assert.doesNotMatch(result.content[0].text, /private\.example/);
});

test("retorna JPEG privado como bloco visual MCP com MIME correto", async () => {
  const env = makeEnv();
  const { tokenBody } = await authorize(env);
  const bytes = jpgBytes();
  const file = attachment("att-jpg", "foto.jpg", "image/jpeg", bytes);
  fixture.attachments.set("card-1", new Map([[file.id, file]]));
  fixture.downloads.set(file.id, { bytes, mimeType: "image/jpeg" });
  const response = await postMcp(env, jsonRpc("tools/call", {
    name: "ler_anexo",
    arguments: { card_id: "card-1", anexo_id: file.id },
  }), tokenBody.access_token);
  const result = (await response.json()).result;
  assert.equal(result.content[1]?.type, "image", JSON.stringify(result));
  assert.equal(result.content[1].mimeType, "image/jpeg");
  assert.equal(result.content[1].data, Buffer.from(bytes).toString("base64"));
  const downloadCall = trelloCalls.at(-1);
  assert.match(downloadCall.url, /\/download\/foto\.jpg$/);
  assert.equal(downloadCall.init.headers.Authorization, `OAuth oauth_consumer_key="${TRELLO_KEY}", oauth_token="${TRELLO_TOKEN}"`);
});

test("retorna PNG privado como bloco visual MCP com MIME correto", async () => {
  const env = makeEnv();
  const { tokenBody } = await authorize(env);
  const bytes = pngBytes();
  const file = attachment("att-png", "comprovante.png", "image/png", bytes);
  fixture.attachments.set("card-1", new Map([[file.id, file]]));
  fixture.downloads.set(file.id, { bytes, mimeType: "image/png" });
  const response = await postMcp(env, jsonRpc("tools/call", {
    name: "ler_anexo",
    arguments: { card_id: "card-1", anexo_id: file.id },
  }), tokenBody.access_token);
  const result = (await response.json()).result;
  assert.equal(result.content[1]?.type, "image", JSON.stringify(result));
  assert.equal(result.content[1].mimeType, "image/png");
  assert.equal(result.content[1].data, Buffer.from(bytes).toString("base64"));
});

test("segue redirect privado do Trello para S3 sem encaminhar credenciais", async () => {
  const env = makeEnv();
  const { tokenBody } = await authorize(env);
  const bytes = new TextEncoder().encode("conteúdo privado");
  const file = attachment("att-private", "nota.txt", "text/plain", bytes);
  fixture.attachments.set("card-1", new Map([[file.id, file]]));
  fixture.downloads.set(file.id, {
    bytes,
    mimeType: "text/plain",
    redirect: "https://trello-attachments.s3.amazonaws.com/private-object",
  });
  const response = await postMcp(env, jsonRpc("tools/call", {
    name: "ler_anexo",
    arguments: { card_id: "card-1", anexo_id: file.id },
  }), tokenBody.access_token);
  assert.match((await response.json()).result.content[0].text, /conteúdo privado/);
  assert.equal(fixture.externalCalls.length, 1);
  assert.equal(new Headers(fixture.externalCalls[0].init.headers).has("Authorization"), false);
});

test("bloqueia redirect de download para host arbitrário", async () => {
  const env = makeEnv();
  const { tokenBody } = await authorize(env);
  const bytes = new TextEncoder().encode("conteúdo");
  const file = attachment("att-redirect", "nota.txt", "text/plain", bytes);
  fixture.attachments.set("card-1", new Map([[file.id, file]]));
  fixture.downloads.set(file.id, {
    bytes,
    mimeType: "text/plain",
    redirect: "https://attacker.example/collect",
  });
  const response = await postMcp(env, jsonRpc("tools/call", {
    name: "ler_anexo",
    arguments: { card_id: "card-1", anexo_id: file.id },
  }), tokenBody.access_token);
  const result = (await response.json()).result;
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /endereço não autorizado/);
  assert.equal(fixture.externalCalls.length, 0);
});

test("retorna conteúdo TXT validado como UTF-8", async () => {
  const env = makeEnv();
  const { tokenBody } = await authorize(env);
  const bytes = new TextEncoder().encode("Data;Valor\n2026-11-16;42,50\n");
  const file = attachment("att-txt", "extrato.csv", "text/csv", bytes);
  fixture.attachments.set("card-1", new Map([[file.id, file]]));
  fixture.downloads.set(file.id, { bytes, mimeType: "text/csv" });
  const response = await postMcp(env, jsonRpc("tools/call", {
    name: "ler_anexo",
    arguments: { card_id: "card-1", anexo_id: file.id },
  }), tokenBody.access_token);
  assert.match((await response.json()).result.content[0].text, /2026-11-16;42,50/);
});

test("bloqueia anexo maior que MAX_ATTACHMENT_BYTES antes do download", async () => {
  const env = makeEnv({ MAX_ATTACHMENT_BYTES: "1024" });
  const { tokenBody } = await authorize(env);
  const file = attachment("att-big", "grande.jpg", "image/jpeg", new Uint8Array(2048));
  fixture.attachments.set("card-1", new Map([[file.id, file]]));
  const response = await postMcp(env, jsonRpc("tools/call", {
    name: "ler_anexo",
    arguments: { card_id: "card-1", anexo_id: file.id },
  }), tokenBody.access_token);
  const result = (await response.json()).result;
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /excede o limite/);
  assert.equal(trelloCalls.some((call) => call.url.includes("/download/")), false);
});

test("retorna erro explícito para PDF sem tentar inventar texto", async () => {
  const env = makeEnv();
  const { tokenBody } = await authorize(env);
  const file = attachment("att-pdf", "relatorio.pdf", "application/pdf", new Uint8Array(100));
  fixture.attachments.set("card-1", new Map([[file.id, file]]));
  const response = await postMcp(env, jsonRpc("tools/call", {
    name: "ler_anexo",
    arguments: { card_id: "card-1", anexo_id: file.id },
  }), tokenBody.access_token);
  const result = (await response.json()).result;
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /extração de PDF, DOCX e XLSX não está implementada/);
  assert.equal(trelloCalls.some((call) => call.url.includes("/download/")), false);
});

test("credenciais Trello inválidas são reportadas sem retornar dados", async () => {
  const env = makeEnv();
  const { tokenBody } = await authorize(env);
  fixture.invalidTrelloCredentials = true;
  const response = await postMcp(env, jsonRpc("tools/call", { name: "listar_boards", arguments: {} }), tokenBody.access_token);
  const result = (await response.json()).result;
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /recusou as credenciais/);
});

test("card e anexo inexistentes viram erros explícitos", async () => {
  const env = makeEnv();
  const { tokenBody } = await authorize(env);
  const cardResponse = await postMcp(env, jsonRpc("tools/call", {
    name: "listar_anexos",
    arguments: { card_id: "missing-card" },
  }), tokenBody.access_token);
  assert.equal((await cardResponse.json()).result.isError, true);

  const attachmentResponse = await postMcp(env, jsonRpc("tools/call", {
    name: "ler_anexo",
    arguments: { card_id: "card-1", anexo_id: "missing-attachment" },
  }), tokenBody.access_token);
  assert.equal((await attachmentResponse.json()).result.isError, true);
});

test("falha HTTP da API do Trello é reportada sem expor o corpo upstream", async () => {
  const env = makeEnv();
  const { tokenBody } = await authorize(env);
  fixture.failures.set("/1/members/me/boards", 503);
  const response = await postMcp(env, jsonRpc("tools/call", { name: "listar_boards", arguments: {} }), tokenBody.access_token);
  const result = (await response.json()).result;
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /falhou \(HTTP 503\)/);
  assert.doesNotMatch(result.content[0].text, /simulated failure/);
});

test("Streamable HTTP valida versão, Accept e métodos", async () => {
  const env = makeEnv();
  const unsupportedVersion = await postMcp(env, jsonRpc("tools/list"), null, { "MCP-Protocol-Version": "1900-01-01" });
  assert.equal(unsupportedVersion.status, 400);
  const badAccept = await worker.fetch(new Request(`${BASE}/mcp`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(jsonRpc("tools/list")),
  }), env);
  assert.equal(badAccept.status, 406);
  const get = await worker.fetch(new Request(`${BASE}/mcp`), env);
  assert.equal(get.status, 405);
  assert.equal(get.headers.get("Allow"), "POST");
});
