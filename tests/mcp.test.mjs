import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const serverPath = new URL("../dist/server.js", import.meta.url).pathname.replace(/^\/(\w:)/, "$1");

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return undefined;
  if (req.headers["content-type"]?.includes("application/x-www-form-urlencoded")) {
    const values = new URLSearchParams(text);
    return Object.fromEntries(values.entries());
  }
  if (req.headers["content-type"]?.includes("multipart/form-data")) return text;
  return JSON.parse(text);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : undefined;
}

function sendJson(res, status, value) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

function startMockZenTao() {
  const requests = [];
  const bug501 = {
    id: 501, product: 46, branch: 0, plan: 0, project: 191, execution: 62, module: 242,
    title: "[MCP-TEST] bug", openedBuild: [{ id: "trunk", title: "trunk" }],
    assignedTo: { account: "alice" }, openedBy: { account: "alice" }, pri: 3, severity: 3,
    type: "codeerror", story: 0, task: 0, steps: "old steps", keywords: "old",
    deadline: "2026-08-30", consumed: 0, mailto: [], notifyEmail: "", feedbackBy: "",
    os: [], browser: [], case: 0, testtask: 0,
  };
  const bug505 = {
    id: 505, product: 46, branch: 0, plan: 0, module: 242, title: "[MCP-TEST] bug form",
    openedBuild: [{ id: "trunk", title: "trunk" }], openedBy: { account: "alice" }, assignedTo: { account: "bob" },
    pri: 1, severity: 1, type: "codeerror", story: 20823, task: 33324,
    steps: "", keywords: "form", deadline: "2026-08-31", consumed: 7.5,
    mailto: ["bob"], notifyEmail: "qa@example.com", feedbackBy: "alice", os: ["windows"], browser: ["chrome"], case: 0, testtask: 0,
  };
  const effort701 = { id: 701, objectID: 301, objectType: "task", date: "2026-08-28", consumed: 1, left: 2, work: "旧工作" };
  const httpServer = createServer(async (req, res) => {
    const body = await readBody(req);
    requests.push({ method: req.method, url: req.url, token: req.headers.token, referer: req.headers.referer, contentType: req.headers["content-type"], body });

    if (req.method === "GET" && req.url?.startsWith("/zentao/api.php/v1/user")) {
      if (req.headers.token === "expired-token") {
        sendJson(res, 401, { error: "token expired" });
        return;
      }
      const url = new URL(req.url, "http://localhost");
      if (url.searchParams.get("fields") === "task") {
        sendJson(res, 200, {
          profile: { id: 7, account: "alice", realname: "Alice" },
          task: {
            total: 3,
            tasks: [
              { id: 101, project: 12, projectName: "Project Alpha", execution: 13, executionName: "Sprint 1", name: "My open task", status: "doing", assignedTo: "alice" },
              { id: 102, project: 12, projectName: "Project Alpha", execution: 13, executionName: "Sprint 1", name: "My done task", status: "done", assignedTo: "alice" },
              { id: 201, project: 22, projectName: "Project Beta", execution: 23, executionName: "Iteration A", name: "My waiting task", status: "wait", assignedTo: "alice" },
            ],
          },
        });
        return;
      }
      if (url.searchParams.get("fields") === "bug") {
        sendJson(res, 200, {
          profile: { id: 7, account: "alice", realname: "Alice" },
          bug: {
            total: 4,
            bugs: [
              { id: 501, product: 46, title: "My active API bug", status: "active", assignedTo: "alice", keywords: "api" },
              { id: 502, product: 46, title: "My resolved UI bug", status: "resolved", assignedTo: "alice", keywords: "ui" },
              { id: 503, product: 46, title: "My closed API bug", status: "closed", assignedTo: "alice", keywords: "api" },
              { id: 504, product: 46, title: "My other active bug", status: "active", assignedTo: "alice", keywords: "other" },
            ],
          },
        });
        return;
      }
      sendJson(res, 200, { profile: { id: 7, account: "alice", realname: "Alice" } });
      return;
    }
    if (req.method === "POST" && req.url === "/zentao/api.php/v1/tokens") {
      sendJson(res, 200, { token: "refreshed-token" });
      return;
    }
    if (req.method === "GET" && req.url?.startsWith("/zentao/api.php/v1/products/46/bugs")) {
      sendJson(res, 200, {
        page: 1, limit: 100, total: 4,
        bugs: [
          { id: 601, product: 46, title: "Assigned active API bug", status: "active", assignedTo: { account: "alice" }, keywords: "api" },
          { id: 602, product: 46, title: "Other active API bug", status: "active", assignedTo: { account: "lisi" }, keywords: "api" },
          { id: 603, product: 46, title: "Assigned resolved API bug", status: "resolved", assignedTo: { account: "alice" }, keywords: "api" },
          { id: 604, product: 46, title: "Assigned active UI bug", status: "active", assignedTo: { account: "alice" }, keywords: "ui" },
        ],
      });
      return;
    }
    if (req.method === "GET" && req.url?.startsWith("/zentao/api.php/v1/products")) {
      sendJson(res, 200, { page: 1, limit: 2, total: 1, products: [{ id: 1, name: "Demo" }] });
      return;
    }
    if (req.method === "GET" && req.url?.startsWith("/zentao/api.php/v1/modules")) {
      sendJson(res, 200, { modules: [{ id: 242, name: "数据服务", root: 46 }] });
      return;
    }
    if (req.method === "GET" && req.url?.startsWith("/zentao/api.php/v1/projects?")) {
      sendJson(res, 200, {
        page: 1,
        limit: 100,
        total: 2,
        projects: [
          { id: 12, name: "Project Alpha" },
          { id: 22, name: "Project Beta" },
        ],
      });
      return;
    }
    if (req.method === "GET" && req.url?.startsWith("/zentao/api.php/v1/projects/12/executions")) {
      sendJson(res, 200, {
        page: 1,
        limit: 100,
        total: 1,
        executions: [{ id: 13, project: 12, name: "Sprint 1" }],
      });
      return;
    }
    if (req.method === "GET" && req.url?.startsWith("/zentao/api.php/v1/projects/22/executions")) {
      sendJson(res, 200, {
        page: 1,
        limit: 100,
        total: 1,
        executions: [{ id: 23, project: 22, name: "Iteration A" }],
      });
      return;
    }
    if (req.method === "GET" && req.url?.startsWith("/zentao/api.php/v1/executions/13/tasks")) {
      sendJson(res, 200, {
        page: 1,
        limit: 100,
        total: 3,
        tasks: [
          { id: 101, execution: 13, name: "My open task", status: "doing", assignedTo: { account: "alice", realname: "Alice" } },
          { id: 102, execution: 13, name: "My done task", status: "done", assignedTo: { account: "alice", realname: "Alice" } },
          { id: 103, execution: 13, name: "Other task", status: "wait", assignedTo: { account: "lisi", realname: "李四" } },
        ],
      });
      return;
    }
    if (req.method === "GET" && req.url?.startsWith("/zentao/api.php/v1/executions/23/tasks")) {
      sendJson(res, 200, {
        page: 1,
        limit: 100,
        total: 1,
        tasks: [{ id: 201, execution: 23, name: "My waiting task", status: "wait", assignedTo: "alice" }],
      });
      return;
    }
    if (req.method === "POST" && req.url === "/zentao/api.php/v1/executions/13/tasks") {
      sendJson(res, 201, { id: 301, execution: 13, ...body });
      return;
    }
    if (req.method === "POST" && req.url === "/zentao/story-create-46-0-242.json") {
      sendJson(res, 200, { result: "success", id: 401, message: "保存成功" });
      return;
    }
    if (req.method === "POST" && req.url === "/zentao/story-edit-401.json") {
      sendJson(res, 200, { status: "success", data: 401 });
      return;
    }
    if (req.method === "PUT" && req.url === "/zentao/api.php/v1/stories/401") {
      sendJson(res, 200, { id: 401, openedBy: "alice", ...body });
      return;
    }
    if (req.method === "POST" && req.url === "/zentao/api.php/v1/stories/401/change") {
      sendJson(res, 200, { id: 401, openedBy: "alice", ...body });
      return;
    }
    if (req.method === "POST" && req.url === "/zentao/api.php/v1/stories/401/close") {
      sendJson(res, 200, { id: 401, status: "closed", ...body });
      return;
    }
    if (req.method === "GET" && req.url === "/zentao/api.php/v1/stories/401") {
      sendJson(res, 200, { id: 401, product: 46, module: 242, plan: 0, parent: 0, title: "[MCP-TEST] story", spec: "需求描述", verify: "", category: "feature", pri: 3, estimate: 0, customDeadline: "2026-09-04", type: "story", status: "active", openedBy: { account: "alice" }, assignedTo: { account: "alice" } });
      return;
    }
    if (req.method === "DELETE" && req.url === "/zentao/api.php/v1/stories/401") {
      sendJson(res, 200, { status: "success" });
      return;
    }
    if (req.method === "POST" && req.url === "/zentao/api.php/v1/products/46/bugs") {
      sendJson(res, 201, { id: 501, product: 46, openedBy: "alice", ...body });
      return;
    }
    if (req.method === "POST" && req.url === "/zentao/bug-create-46--from=global.html") {
      if (body?.title === "[MCP-TEST] empty bug response") {
        res.writeHead(200);
        res.end();
        return;
      }
      Object.assign(bug505, {
        title: body.title,
        deadline: body.deadline,
        consumed: Number(body.consumed),
        mailto: body["mailto[]"] ? [body["mailto[]"]] : [],
        notifyEmail: body.notifyEmail,
        steps: body.steps,
      });
      sendJson(res, 200, { result: "success", id: 505, message: "保存成功" });
      return;
    }
    if (req.method === "POST" && req.url === "/zentao/bug-edit-501.html") {
      Object.assign(bug501, {
        steps: body.steps,
        deadline: body.deadline,
        consumed: Number(body.consumed),
        mailto: body["mailto[]"] ? [body["mailto[]"]] : [],
        notifyEmail: body.notifyEmail,
      });
      sendJson(res, 200, { status: "success", data: 501 });
      return;
    }
    if (req.method === "PUT" && req.url === "/zentao/api.php/v1/bugs/501") {
      sendJson(res, 200, { id: 501, openedBy: "alice", ...body });
      return;
    }
    if (req.method === "POST" && req.url === "/zentao/api.php/v1/bugs/501/resolve") {
      sendJson(res, 200, { id: 501, status: "resolved", ...body });
      return;
    }
    if (req.method === "POST" && req.url === "/zentao/api.php/v1/bugs/501/close") {
      sendJson(res, 200, { id: 501, status: "closed", ...body });
      return;
    }
    if (req.method === "GET" && req.url === "/zentao/api.php/v1/bugs/501") {
      sendJson(res, 200, bug501);
      return;
    }
    if (req.method === "GET" && req.url === "/zentao/api.php/v1/bugs/505") {
      sendJson(res, 200, bug505);
      return;
    }
    if (req.method === "DELETE" && req.url === "/zentao/api.php/v1/bugs/501") {
      sendJson(res, 200, { status: "success" });
      return;
    }
    if (req.method === "POST" && req.url === "/zentao/api.php/v1/tasks/301/estimate") {
      sendJson(res, 200, { id: 301, consumed: body.consumed[0], left: body.left[0], status: "doing" });
      return;
    }
    if (req.method === "GET" && req.url === "/zentao/api.php/v1/tasks/301/estimate") {
      sendJson(res, 200, { effort: effort701.id ? [effort701] : [] });
      return;
    }
    if (req.method === "POST" && req.url === "/zentao/task-editEstimate-701.json") {
      Object.assign(effort701, { date: body.date, consumed: Number(body.consumed), left: Number(body.left), work: body.work });
      sendJson(res, 200, { status: "success", data: 701 });
      return;
    }
    if (req.method === "POST" && req.url === "/zentao/task-deleteEstimate-701-yes.json") {
      effort701.id = 0;
      sendJson(res, 200, { status: "success" });
      return;
    }
    if (req.method === "GET" && req.url === "/zentao/api.php/v1/tasks/301") {
      sendJson(res, 200, { id: 301, execution: 13, name: "[MCP-TEST] task", openedBy: { account: "alice" } });
      return;
    }
    if (req.method === "GET" && req.url === "/zentao/api.php/v1/tasks/101") {
      sendJson(res, 200, { id: 101, execution: 13, name: "[MCP-TEST] lifecycle task", consumed: 1, left: 7, openedBy: { account: "alice" } });
      return;
    }
    if (req.method === "DELETE" && req.url === "/zentao/api.php/v1/tasks/301") {
      sendJson(res, 200, { status: "success" });
      return;
    }
    if (req.method === "PUT" && req.url === "/zentao/api.php/v1/tasks/101") {
      sendJson(res, 200, { id: 101, ...body });
      return;
    }
    if (req.method === "POST" && req.url === "/zentao/api.php/v1/tasks/101/start") {
      sendJson(res, 200, { id: 101, status: "doing", ...body });
      return;
    }
    if (req.method === "POST" && req.url === "/zentao/api.php/v1/tasks/101/finish") {
      sendJson(res, 200, { id: 101, status: "done", ...body });
      return;
    }

    sendJson(res, 404, { error: "not found" });
  });
  return { httpServer, requests };
}

async function startClient(t, envOverrides = {}) {
  const mock = startMockZenTao();
  mock.httpServer.listen(0, "127.0.0.1");
  await once(mock.httpServer, "listening");
  const address = mock.httpServer.address();
  assert.ok(address && typeof address === "object");

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: {
      ...process.env,
      ZENTAO_URL: `http://127.0.0.1:${address.port}/zentao`,
      ZENTAO_TOKEN: "test-token",
      ...envOverrides,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "zentao-v1-test-client", version: "1.0.0" });
  t.after(async () => {
    await client.close().catch(() => undefined);
    await new Promise((resolve) => mock.httpServer.close(resolve));
  });
  await client.connect(transport);
  return { client, mock };
}

async function startUnconfiguredClient(t) {
  const env = { ...process.env };
  delete env.ZENTAO_URL;
  delete env.ZENTAO_TOKEN;
  delete env.ZENTAO_ACCOUNT;
  delete env.ZENTAO_PASSWORD;
  env.ZENTAO_CONFIG_PATH = join(tmpdir(), `zentao-unconfigured-${process.pid}-${Date.now()}.json`);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env,
    stderr: "pipe",
  });
  const client = new Client({ name: "zentao-v1-unconfigured-test-client", version: "1.0.0" });
  t.after(async () => client.close().catch(() => undefined));
  await client.connect(transport);
  return client;
}

test("starts without credentials and returns setup guidance instead of disconnecting", async (t) => {
  const client = await startUnconfiguredClient(t);
  const listed = await client.listTools();
  assert.ok(listed.tools.some((tool) => tool.name === "zentao_setup_status"));
  assert.ok(listed.tools.some((tool) => tool.name === "zentao_list_my_tasks"));

  const status = await client.callTool({ name: "zentao_setup_status", arguments: {} });
  assert.equal(status.isError, undefined);
  const payload = JSON.parse(status.content?.[0]?.text ?? "{}");
  assert.equal(payload.configured, false);
  assert.equal(payload.setupRequired, true);
  assert.match(payload.setupCommand, /configure\.mjs/);
  assert.doesNotMatch(status.content?.[0]?.text ?? "", /ZENTAO_PASSWORD\s*[:=]\s*[^*]/);

  const products = await client.callTool({ name: "zentao_list_products", arguments: {} });
  assert.equal(products.isError, true);
  assert.match(products.content?.[0]?.text ?? "", /SETUP_REQUIRED/);
  assert.match(products.content?.[0]?.text ?? "", /configure\.mjs/);
});

test("exposes ZenTao tools over MCP stdio and forwards v1 requests", async (t) => {
  const { client, mock } = await startClient(t);
  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name);
  assert.ok(names.includes("zentao_whoami"));
  assert.ok(names.includes("zentao_list_products"));
  assert.ok(names.includes("zentao_list_project_executions"));
  assert.ok(names.includes("zentao_list_project_tasks"));
  assert.ok(names.includes("zentao_list_my_tasks"));
  assert.ok(names.includes("zentao_list_my_bugs"));
  assert.ok(names.includes("zentao_create_task"));
  assert.ok(names.includes("zentao_update_task"));
  assert.ok(names.includes("zentao_start_task"));
  assert.ok(names.includes("zentao_pause_task"));
  assert.ok(names.includes("zentao_restart_task"));
  assert.ok(names.includes("zentao_finish_task"));
  assert.ok(names.includes("zentao_close_task"));

  const result = await client.callTool({
    name: "zentao_list_products",
    arguments: { page: 1, limit: 2 },
  });
  assert.equal(result.isError, undefined);
  assert.match(result.content?.[0]?.text ?? "", /Demo/);
  assert.equal(mock.requests[0]?.url, "/zentao/api.php/v1/products?page=1&limit=2");
  assert.equal(mock.requests[0]?.token, "test-token");
});

test("automatically logs in and retries once when the configured token expires", async (t) => {
  const { client, mock } = await startClient(t, {
    ZENTAO_TOKEN: "expired-token",
    ZENTAO_ACCOUNT: "alice",
    ZENTAO_PASSWORD: "test-password",
  });
  const result = await client.callTool({ name: "zentao_whoami", arguments: {} });

  assert.equal(result.isError, undefined);
  assert.match(result.content?.[0]?.text ?? "", /alice/);
  assert.equal(mock.requests.length, 3);
  assert.equal(mock.requests[0].token, "expired-token");
  assert.equal(mock.requests[1].method, "POST");
  assert.equal(mock.requests[1].url, "/zentao/api.php/v1/tokens");
  assert.deepEqual(mock.requests[1].body, { account: "alice", password: "test-password" });
  assert.equal(mock.requests[2].token, "refreshed-token");
});

test("lists project executions using the official REST API v1 route", async (t) => {
  const { client, mock } = await startClient(t);
  const result = await client.callTool({
    name: "zentao_list_project_executions",
    arguments: { project: 12, page: 1, limit: 100 },
  });
  assert.equal(result.isError, undefined);
  assert.match(result.content?.[0]?.text ?? "", /Sprint 1/);
  assert.equal(mock.requests[0]?.url, "/zentao/api.php/v1/projects/12/executions?page=1&limit=100");
});

test("queries current user's tasks directly without scanning projects or executions", async (t) => {
  const { client, mock } = await startClient(t);
  const result = await client.callTool({ name: "zentao_list_my_tasks", arguments: {} });
  assert.equal(result.isError, undefined);
  const payload = JSON.parse(result.content?.[0]?.text ?? "{}");
  assert.equal(payload.account, "alice");
  assert.equal(payload.total, 2);
  assert.deepEqual(payload.tasks.map((task) => task.id).sort(), [101, 201]);
  assert.equal(payload.reportedTotal, 3);
  assert.equal(mock.requests.length, 1);
  const requestUrl = new URL(mock.requests[0].url, "http://localhost");
  assert.equal(requestUrl.pathname, "/zentao/api.php/v1/user");
  assert.equal(requestUrl.searchParams.get("fields"), "task");
  assert.equal(requestUrl.searchParams.get("type"), "assignedTo");
  assert.equal(requestUrl.searchParams.get("page"), "1");
  assert.equal(requestUrl.searchParams.get("limit"), "100");
  assert.equal(mock.requests.some((request) => request.url?.includes("/projects")), false);
  assert.equal(mock.requests.some((request) => request.url?.includes("/executions")), false);
});

test("queries and filters current user's bugs directly without scanning products or writing files", async (t) => {
  const { client, mock } = await startClient(t);
  const result = await client.callTool({ name: "zentao_list_my_bugs", arguments: { keyword: "api" } });
  assert.equal(result.isError, undefined);
  const payload = JSON.parse(result.content?.[0]?.text ?? "{}");
  assert.equal(payload.account, "alice");
  assert.equal(payload.reportedTotal, 4);
  assert.equal(payload.total, 1);
  assert.deepEqual(payload.bugs.map((bug) => bug.id), [501]);
  assert.equal(mock.requests.length, 1);
  const requestUrl = new URL(mock.requests[0].url, "http://localhost");
  assert.equal(requestUrl.pathname, "/zentao/api.php/v1/user");
  assert.equal(requestUrl.searchParams.get("fields"), "bug");
  assert.equal(requestUrl.searchParams.get("type"), "assignedTo");
  assert.equal(mock.requests.some((request) => request.url?.includes("/products")), false);
  assert.equal(mock.requests.some((request) => request.url?.includes("/projects")), false);
});

test("filters product bugs inside the MCP response", async (t) => {
  const { client, mock } = await startClient(t);
  const result = await client.callTool({ name: "zentao_list_bugs", arguments: { product: 46, assignedTo: "alice", keyword: "api" } });
  assert.equal(result.isError, undefined);
  const payload = JSON.parse(result.content?.[0]?.text ?? "{}");
  assert.equal(payload.total, 1);
  assert.deepEqual(payload.bugs.map((bug) => bug.id), [601]);
  assert.equal(mock.requests.length, 1);
  assert.equal(new URL(mock.requests[0].url, "http://localhost").pathname, "/zentao/api.php/v1/products/46/bugs");
});

test("can aggregate and filter all tasks for one project", async (t) => {
  const { client } = await startClient(t);
  const result = await client.callTool({
    name: "zentao_list_project_tasks",
    arguments: { project: 12, assignedTo: "alice", includeFinished: true },
  });
  assert.equal(result.isError, undefined);
  const payload = JSON.parse(result.content?.[0]?.text ?? "{}");
  assert.equal(payload.total, 2);
  assert.deepEqual(payload.tasks.map((task) => task.id).sort(), [101, 102]);
});

test("previews and creates tasks with ZenTao v1 fields", async (t) => {
  const { client, mock } = await startClient(t);
  const args = {
    execution: 13,
    name: "Implement export",
    assignedTo: "alice",
    type: "devel",
    estStarted: "2026-08-28",
    deadline: "2026-08-30",
    module: 5,
    story: 88,
    pri: 2,
    estimate: 8,
    desc: "CSV export",
  };

  const preview = await client.callTool({ name: "zentao_create_task", arguments: args });
  assert.equal(preview.isError, undefined);
  assert.match(preview.content?.[0]?.text ?? "", /预览模式/);
  assert.equal(mock.requests.length, 0);

  const created = await client.callTool({
    name: "zentao_create_task",
    arguments: { ...args, dryRun: false, confirm: true },
  });
  assert.equal(created.isError, undefined);
  const createRequest = mock.requests.find((request) => request.method === "POST");
  assert.ok(createRequest);
  assert.equal(createRequest.url, "/zentao/api.php/v1/executions/13/tasks");
  assert.deepEqual(createRequest.body, {
    name: "Implement export",
    assignedTo: "alice",
    type: "devel",
    estStarted: "2026-08-28",
    deadline: "2026-08-30",
    module: 5,
    story: 88,
    pri: 2,
    estimate: 8,
    desc: "CSV export",
  });
});

test("submits ZenTao 18.6 multiple-task members and sums their estimates", async (t) => {
  const { client, mock } = await startClient(t, { ZENTAO_ACCOUNT: "alice" });
  const result = await client.callTool({ name: "zentao_create_task", arguments: {
    execution: 13,
    name: "多人联调任务",
    type: "测试",
    module: 5,
    story: 88,
    assignedTo: "alice",
    pri: 1,
    estimate: 999,
    desc: "多人协作验证",
    estStarted: "2026-08-28",
    deadline: "2026-08-30",
    mailto: ["qa", "bob"],
    multiple: true,
    mode: "multi",
    team: ["alice", "bob"],
    teamEstimate: [3, 4.5],
    dryRun: false,
    confirm: true,
  } });
  assert.equal(result.isError, undefined);

  const createRequest = mock.requests.find((request) => request.url === "/zentao/api.php/v1/executions/13/tasks");
  assert.ok(createRequest);
  assert.deepEqual(createRequest.body, {
    name: "多人联调任务",
    assignedTo: "alice",
    type: "test",
    estStarted: "2026-08-28",
    deadline: "2026-08-30",
    module: 5,
    story: 88,
    pri: 1,
    estimate: 7.5,
    desc: "多人协作验证",
    mailto: ["qa", "bob"],
    multiple: 1,
    mode: "multi",
    team: ["alice", "bob"],
    teamEstimate: [3, 4.5],
  });
});

test("rejects a task deadline that is not later than its planned start", async (t) => {
  const { client, mock } = await startClient(t, { ZENTAO_ACCOUNT: "alice" });
  const result = await client.callTool({ name: "zentao_create_task", arguments: {
    execution: 13,
    name: "日期校验任务",
    estStarted: "2026-08-31",
    deadline: "2026-08-31",
  } });
  assert.equal(result.isError, true);
  assert.match(result.content?.[0]?.text ?? "", /deadline 必须晚于 estStarted/);
  assert.equal(mock.requests.length, 0);
});

test("uploads task attachments through the ZenTao 18.6 multipart form controller", async (t) => {
  const { client, mock } = await startClient(t, { ZENTAO_ACCOUNT: "alice" });
  const tempDir = await mkdtemp(join(tmpdir(), "zentao-v1-task-attachment-"));
  const attachmentPath = join(tempDir, "task-note.txt");
  await writeFile(attachmentPath, "task attachment content", "utf8");
  t.after(() => rm(tempDir, { recursive: true, force: true }));

  const result = await client.callTool({ name: "zentao_create_task", arguments: {
    execution: 13,
    name: "带附件的规划任务",
    type: "规划",
    assignedTo: "alice",
    estStarted: "2026-08-31",
    deadline: "2026-09-01",
    attachments: [{ path: attachmentPath, label: "验证附件" }],
    after: "toTaskList",
    dryRun: false,
    confirm: true,
  } });
  assert.equal(result.isError, undefined);

  const request = mock.requests.find((item) => item.url === "/zentao/api.php/v1/executions/13/tasks" && item.contentType?.startsWith("multipart/form-data"));
  assert.ok(request);
  assert.match(request.contentType ?? "", /^multipart\/form-data; boundary=/);
  assert.match(request.body, /name="type"\r\n\r\ndesign/);
  assert.match(request.body, /name="assignedTo\[\]"\r\n\r\nalice/);
  assert.match(request.body, /name="files\[\]"; filename="task-note\.txt"/);
  assert.match(request.body, /task attachment content/);
  assert.match(request.body, /name="labels\[\]"\r\n\r\n验证附件/);
});

test("covers ZenTao 18.6 story create, change, close, and guarded delete contracts", async (t) => {
  const { client, mock } = await startClient(t, { ZENTAO_ACCOUNT: "alice" });
  const createArgs = { product: 46, title: "[MCP-TEST] story", spec: "需求描述", module: 242, dryRun: false, confirm: true };
  const created = await client.callTool({ name: "zentao_create_story", arguments: createArgs });
  assert.equal(created.isError, undefined);
  const create = mock.requests.find((request) => request.url === "/zentao/story-create-46-0-242.json");
  assert.match(create.referer ?? "", /\/zentao\/story-create-46-0-242\.html$/);
  assert.deepEqual(create.body, {
    product: "46", module: "242", "branches[0]": "0", "modules[0]": "242", "plans[0]": "0", plan: "0",
    assignedTo: "alice", title: "[MCP-TEST] story", spec: "需求描述", category: "feature", pri: "3",
    estimate: "0", type: "story", status: "active", needNotReview: "1",
  });

  const invalidBasicEdit = await client.callTool({ name: "zentao_update_story", arguments: { id: 401, pri: 2, dryRun: false, confirm: true } });
  assert.equal(invalidBasicEdit.isError, true);
  assert.match(invalidBasicEdit.content?.[0]?.text ?? "", /至少提供 title、spec、verify 或 comment/);
  const changed = await client.callTool({ name: "zentao_update_story", arguments: { id: 401, title: "[MCP-TEST] story", spec: "更新后的描述", verify: "验收标准", dryRun: false, confirm: true } });
  assert.equal(changed.isError, undefined);
  await client.callTool({ name: "zentao_close_story", arguments: { id: 401, dryRun: false, confirm: true } });
  await client.callTool({ name: "zentao_delete_story", arguments: { id: 401, expectedTitle: "[MCP-TEST] story", dryRun: false, confirm: true } });

  assert.equal(mock.requests.some((request) => request.method === "POST" && request.url === "/zentao/story-edit-401.json"), false);
  assert.ok(mock.requests.some((request) => request.method === "POST" && request.url === "/zentao/api.php/v1/stories/401/change"));
  assert.ok(mock.requests.some((request) => request.url === "/zentao/api.php/v1/stories/401/close"));
  assert.ok(mock.requests.some((request) => request.method === "DELETE" && request.url === "/zentao/api.php/v1/stories/401"));
});

test("submits the complete ZenTao story form, including assignment, reviewers, parent, and multiple plans", async (t) => {
  const { client, mock } = await startClient(t, { ZENTAO_ACCOUNT: "alice" });
  const created = await client.callTool({ name: "zentao_create_story", arguments: {
    product: 46,
    title: "完整需求表单",
    spec: "完整需求描述",
    verify: "验收标准",
    module: 242,
    plan: [11, 12],
    assignedTo: "bob",
    reviewer: ["bob", "po"],
    parent: 20820,
    source: "项目实施方案",
    sourceNote: "实施阶段提出",
    category: "功能",
    pri: 1,
    estimate: 7.5,
    mailto: ["qa", "bob"],
    keywords: "完整,表单",
    dryRun: false,
    confirm: true,
  } });
  assert.equal(created.isError, undefined);

  const create = mock.requests.find((request) => request.url === "/zentao/story-create-46-0-242.json");
  assert.ok(create);
  assert.deepEqual(create.body, {
    product: "46", module: "242", "branches[0]": "0", "modules[0]": "242",
    "plans[0]": "11", "plans[1]": "12", plan: "11", assignedTo: "bob",
    "reviewer[]": "po", parent: "20820", title: "完整需求表单", spec: "完整需求描述",
    verify: "验收标准", source: "项目实施方案", sourceNote: "实施阶段提出", category: "feature",
    pri: "1", estimate: "7.5", "mailto[]": "bob", keywords: "完整,表单",
    type: "story", status: "active",
  });
});

test("covers ZenTao 18.6 bug create, edit, resolve, close, and guarded delete contracts", async (t) => {
  const { client, mock } = await startClient(t, { ZENTAO_ACCOUNT: "alice" });
  await client.callTool({ name: "zentao_create_bug", arguments: { product: 46, title: "[MCP-TEST] bug", module: 242, dryRun: false, confirm: true } });
  const create = mock.requests.find((request) => request.url === "/zentao/api.php/v1/products/46/bugs");
  assert.deepEqual(create.body, { product: 46, title: "[MCP-TEST] bug", module: 242, openedBuild: "trunk", pri: 3, severity: 3, type: "codeerror" });

  await client.callTool({ name: "zentao_update_bug", arguments: { id: 501, severity: 2, dryRun: false, confirm: true } });
  await client.callTool({ name: "zentao_resolve_bug", arguments: { id: 501, dryRun: false, confirm: true } });
  await client.callTool({ name: "zentao_close_bug", arguments: { id: 501, dryRun: false, confirm: true } });
  await client.callTool({ name: "zentao_delete_bug", arguments: { id: 501, expectedTitle: "[MCP-TEST] bug", dryRun: false, confirm: true } });

  assert.ok(mock.requests.some((request) => request.method === "PUT" && request.url === "/zentao/api.php/v1/bugs/501"));
  const resolve = mock.requests.find((request) => request.url === "/zentao/api.php/v1/bugs/501/resolve");
  assert.deepEqual(resolve.body, { resolution: "fixed", resolvedBuild: "trunk" });
  assert.ok(mock.requests.some((request) => request.url === "/zentao/api.php/v1/bugs/501/close"));
  assert.ok(mock.requests.some((request) => request.method === "DELETE" && request.url === "/zentao/api.php/v1/bugs/501"));
});

test("routes Bug form-only fields and shared CC fields through the official controller", async (t) => {
  const { client, mock } = await startClient(t, { ZENTAO_ACCOUNT: "alice" });
  const args = {
    product: 46, title: "[MCP-TEST] bug form", module: 242, branch: 0, plan: 0,
    openedBuild: ["trunk"], assignedTo: "bob", pri: 1, severity: 1, type: "代码错误",
    story: 20823, task: 33324, steps: "【现象】提交失败【复现步骤】1. 填写表单；2. 点击提交；3. 页面提示必填字段缺少。【期望】明确提示缺少的字段。", keywords: "form", deadline: "2026-08-31",
    estimate: 7.5, mailto: ["bob"], notifyEmail: "qa@example.com", feedbackBy: "alice",
    os: ["windows"], browser: ["chrome"], case: 0, testtask: 0,
    dryRun: false, confirm: true,
  };
  const created = await client.callTool({ name: "zentao_create_bug", arguments: args });
  assert.equal(created.isError, undefined);
  const create = mock.requests.find((request) => request.url === "/zentao/bug-create-46--from=global.html");
  assert.ok(create);
  assert.equal(create.body.product, "46");
  assert.equal(create.body.type, "codeerror");
  assert.equal(create.body.deadline, "2026-08-31");
  assert.equal(create.body.consumed, "7.5");
  assert.equal(create.body["mailto[]"], "bob");
  assert.equal(create.body.notifyEmail, "qa@example.com");
  assert.equal(create.body.steps, "<p><strong>【现象】</strong> 提交失败</p><p><strong>【复现步骤】</strong></p><ol><li>填写表单</li><li>点击提交</li><li>页面提示必填字段缺少。</li></ol><p><strong>【期望】</strong> 明确提示缺少的字段。</p>");

  const updated = await client.callTool({ name: "zentao_update_bug", arguments: { id: 501, steps: "1. 打开页面\n2. 提交表单", deadline: "2026-08-31", estimate: 7.5, mailto: ["bob"], notifyEmail: "qa@example.com", dryRun: false, confirm: true } });
  assert.equal(updated.isError, undefined);
  const edit = mock.requests.find((request) => request.url === "/zentao/bug-edit-501.html");
  assert.ok(edit);
  assert.equal(edit.body.title, "[MCP-TEST] bug");
  assert.equal(edit.body.deadline, "2026-08-31");
  assert.equal(edit.body.consumed, "7.5");
  assert.equal(edit.body["mailto[]"], "bob");
  assert.equal(edit.body.steps, "<ol><li>打开页面</li><li>提交表单</li></ol>");
});

test("records task effort with the ZenTao 18.6 array payload and guards deletion", async (t) => {
  const { client, mock } = await startClient(t, { ZENTAO_ACCOUNT: "alice" });
  await client.callTool({ name: "zentao_record_task_effort", arguments: { id: 301, date: "2026-08-28", consumed: 0.5, left: 0.5, work: "接口测试", dryRun: false, confirm: true } });
  const effort = mock.requests.find((request) => request.url === "/zentao/api.php/v1/tasks/301/estimate");
  assert.deepEqual(effort.body, { id: [1], dates: ["2026-08-28"], consumed: [0.5], left: [0.5], work: ["接口测试"], date: "2026-08-28", objectType: "task", objectID: 301 });

  await client.callTool({ name: "zentao_delete_task", arguments: { id: 301, expectedName: "[MCP-TEST] task", dryRun: false, confirm: true } });
  assert.ok(mock.requests.some((request) => request.method === "DELETE" && request.url === "/zentao/api.php/v1/tasks/301"));
});

test("lists, edits, and deletes a task effort through the official ZenTao controllers", async (t) => {
  const { client, mock } = await startClient(t, { ZENTAO_ACCOUNT: "alice" });

  const listed = await client.callTool({ name: "zentao_list_task_efforts", arguments: { taskId: 301 } });
  assert.equal(listed.isError, undefined);
  assert.match(listed.content?.[0]?.text ?? "", /"id": 701/);

  const updated = await client.callTool({ name: "zentao_update_task_effort", arguments: {
    taskId: 301, effortId: 701, date: "2026-08-29", consumed: 1.5, left: 1, work: "更新后的工作内容", dryRun: false, confirm: true,
  } });
  assert.equal(updated.isError, undefined);
  const edit = mock.requests.find((request) => request.url === "/zentao/task-editEstimate-701.json");
  assert.deepEqual(edit?.body, { date: "2026-08-29", consumed: "1.5", left: "1", work: "更新后的工作内容" });
  assert.match(updated.content?.[0]?.text ?? "", /"verified": true/);

  const deleted = await client.callTool({ name: "zentao_delete_task_effort", arguments: { taskId: 301, effortId: 701, dryRun: false, confirm: true } });
  assert.equal(deleted.isError, undefined);
  assert.ok(mock.requests.some((request) => request.url === "/zentao/task-deleteEstimate-701-yes.json"));
  assert.match(deleted.content?.[0]?.text ?? "", /"deleted": true/);
});

test("refuses guarded deletion when the expected title does not match", async (t) => {
  const { client, mock } = await startClient(t, { ZENTAO_ACCOUNT: "alice" });
  const result = await client.callTool({ name: "zentao_delete_bug", arguments: { id: 501, expectedTitle: "wrong title", dryRun: false, confirm: true } });
  assert.equal(result.isError, true);
  assert.match(result.content?.[0]?.text ?? "", /安全校验失败/);
  assert.equal(mock.requests.some((request) => request.method === "DELETE"), false);
});

test("previews task lifecycle operations and only writes after explicit confirmation", async (t) => {
  const { client, mock } = await startClient(t);

  const updatePreview = await client.callTool({
    name: "zentao_update_task",
    arguments: { id: 101, assignedTo: "lisi", deadline: "2026-09-01" },
  });
  assert.match(updatePreview.content?.[0]?.text ?? "", /预览模式/);
  assert.equal(mock.requests.length, 0);

  await client.callTool({
    name: "zentao_update_task",
    arguments: { id: 101, assignedTo: "lisi", deadline: "2026-09-01", dryRun: false, confirm: true },
  });
  const updateRequest = mock.requests.find((request) => request.method === "PUT");
  assert.deepEqual(updateRequest?.body, { assignedTo: "lisi", deadline: "2026-09-01" });

  const startPreview = await client.callTool({
    name: "zentao_start_task",
    arguments: { id: 101, consumed: 1, left: 7, comment: "开始开发" },
  });
  assert.match(startPreview.content?.[0]?.text ?? "", /预览模式/);
  assert.equal(mock.requests.filter((request) => request.method === "POST").length, 0);

  await client.callTool({
    name: "zentao_start_task",
    arguments: { id: 101, consumed: 1, left: 7, comment: "开始开发", dryRun: false, confirm: true },
  });
  assert.ok(mock.requests.some((request) => request.url === "/zentao/api.php/v1/tasks/101/start"));

  await client.callTool({
    name: "zentao_start_task",
    arguments: { id: 101, comment: "使用当前工时开始", dryRun: false, confirm: true },
  });
  const safeStart = mock.requests.filter((request) => request.url === "/zentao/api.php/v1/tasks/101/start").at(-1);
  assert.equal(safeStart?.body.consumed, 1);
  assert.equal(safeStart?.body.left, 7);

  await client.callTool({
    name: "zentao_finish_task",
    arguments: { id: 101, currentConsumed: 7, comment: "开发完成", dryRun: false, confirm: true },
  });
  const finishRequest = mock.requests.find((request) => request.url === "/zentao/api.php/v1/tasks/101/finish");
  assert.equal(finishRequest?.body.currentConsumed, 7);
  assert.equal(finishRequest?.body.comment, "开发完成");
  assert.match(finishRequest?.body.finishedDate ?? "", /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
});

test("blocks finishing a task when currentConsumed is mistaken for total consumed", async (t) => {
  const { client, mock } = await startClient(t, { ZENTAO_ACCOUNT: "alice" });
  const result = await client.callTool({
    name: "zentao_finish_task",
    arguments: { id: 101, currentConsumed: 8, dryRun: false, confirm: true },
  });
  assert.equal(result.isError, true);
  assert.match(result.content?.[0]?.text ?? "", /本次新增工时.*当前剩余工时 7/);
  assert.equal(mock.requests.some((request) => request.url === "/zentao/api.php/v1/tasks/101/finish"), false);
});

test("does not retry a Bug form request after an empty response", async (t) => {
  const { client, mock } = await startClient(t, { ZENTAO_ACCOUNT: "alice" });
  const result = await client.callTool({
    name: "zentao_create_bug",
    arguments: { product: 46, title: "[MCP-TEST] empty bug response", module: 242, deadline: "2026-08-31", dryRun: false, confirm: true },
  });
  assert.equal(result.isError, true);
  assert.match(result.content?.[0]?.text ?? "", /HTTP 200 空响应/);
  assert.equal(mock.requests.filter((request) => request.url === "/zentao/bug-create-46--from=global.html").length, 1);
  assert.equal(mock.requests.filter((request) => request.url?.startsWith("/zentao/api.php/v1/products/46/bugs")).length, 1);
});

