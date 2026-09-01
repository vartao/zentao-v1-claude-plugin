import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

type StoredCredentials = { url?: string; account?: string; token?: string; password?: string };
const credentialPath = process.env.ZENTAO_CONFIG_PATH ?? resolve(homedir(), ".config", "zentao-v1", "credentials.json");

function readStoredCredentials(): StoredCredentials {
  try {
    if (!existsSync(credentialPath)) return {};
    const value = JSON.parse(readFileSync(credentialPath, "utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as StoredCredentials : {};
  } catch {
    return {};
  }
}

const storedCredentials = readStoredCredentials();
const baseUrl = (process.env.ZENTAO_URL ?? storedCredentials.url ?? "").replace(/\/+$/, "");
const configuredToken = (process.env.ZENTAO_TOKEN ?? storedCredentials.token)?.trim();
const account = (process.env.ZENTAO_ACCOUNT ?? storedCredentials.account)?.trim();
const password = process.env.ZENTAO_PASSWORD ?? storedCredentials.password;
const configured = Boolean(baseUrl && (configuredToken || (account && password)));
const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const setupScriptCandidates = [
  resolve(moduleDirectory, "scripts/configure.mjs"),
  resolve(moduleDirectory, "../scripts/configure.mjs"),
];
const setupScript = setupScriptCandidates.find(existsSync) ?? setupScriptCandidates[1];
const setupCommand = `node "${setupScript}"`;

class SetupRequiredError extends Error {
  constructor() {
    super(`SETUP_REQUIRED: zentao-v1 尚未配置。请在终端运行：${setupCommand}。脚本会安全提示输入禅道地址、账号和密码，验证成功后保存到当前用户配置目录；然后重启 Claude Code。`);
  }
}

class ZentaoClient {
  private token: string | undefined = configuredToken;

  private async login(): Promise<string> {
    if (!configured) throw new SetupRequiredError();
    if (!account || !password) throw new Error("ZenTao Token 已失效，但未配置账号密码，无法自动重新登录。请重新运行配置脚本。");
    const response = await fetch(`${baseUrl}/api.php/v1/tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account, password }),
    });
    const payload = await parseResponse(response);
    if (!payload || typeof payload !== "object" || !("token" in payload) || typeof payload.token !== "string") {
      throw new Error(`ZenTao token request failed: ${JSON.stringify(payload)}`);
    }
    this.token = payload.token;
    return this.token;
  }

  private async ensureToken(): Promise<string> {
    if (!configured) throw new SetupRequiredError();
    if (this.token) return this.token;
    return this.login();
  }

  async request(path: string, options: { method?: string; query?: Record<string, unknown>; body?: unknown } = {}): Promise<unknown> {
    if (!configured) throw new SetupRequiredError();
    const url = new URL(`${baseUrl}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
    }
    const performRequest = async (token: string) => {
      const headers: Record<string, string> = { Token: token, Accept: "application/json" };
      const init: RequestInit = { method: options.method ?? "GET", headers };
      if (options.body !== undefined) {
        headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(options.body);
      }
      const response = await fetch(url, init);
      return { response, payload: await parseResponse(response) };
    };

    let result = await performRequest(await this.ensureToken());
    if ((result.response.status === 401 || result.response.status === 403) && account && password) {
      // Token 过期后只重新登录并重试一次，避免无限循环。401/403 请求本身未被禅道执行，
      // 因而创建、修改等写请求也可以安全重试。
      this.token = undefined;
      result = await performRequest(await this.login());
    }

    const { response, payload } = result;
    if (!response.ok) throw new Error(`ZenTao HTTP ${response.status}: ${JSON.stringify(payload)}`);
    if (payload && typeof payload === "object" && "error" in payload && payload.error) {
      throw new Error(`ZenTao API error: ${String(payload.error)}`);
    }
    return payload;
  }

  /**
   * Call a normal ZenTao controller with a form payload and JSON view.
   *
   * ZenTao 18.6's official REST story-create entry has a fixed whitelist that
   * accepts the same Token header and processes fields exposed by the standard
   * ZenTao story form, including reviewer and mailto selections.
   */
  async formRequest(path: string, fields: Record<string, unknown>, attachments: Array<{ path: string; label?: string }> = []): Promise<unknown> {
    if (!configured) throw new SetupRequiredError();
    const form = attachments.length ? new FormData() : new URLSearchParams();
    const append = (key: string, value: string) => {
      if (attachments.length) (form as FormData).append(key, value);
      else (form as URLSearchParams).append(key, value);
    };
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        for (const item of value) append(`${key}[]`, String(item));
      } else {
        append(key, String(value));
      }
    }
    for (const attachment of attachments) {
      if (!existsSync(attachment.path)) throw new Error(`附件不存在：${attachment.path}`);
      const bytes = new Uint8Array(readFileSync(attachment.path));
      (form as FormData).append("files[]", new Blob([bytes]), basename(attachment.path));
      (form as FormData).append("labels[]", attachment.label ?? "");
    }
    const performRequest = async (token: string) => {
      const headers: Record<string, string> = {
        Token: token,
        Accept: "application/json",
        "X-Requested-With": "XMLHttpRequest",
        Referer: `${baseUrl}${path.replace(/\.json(?=\?|$)/, ".html")}`,
      };
      if (!attachments.length) headers["Content-Type"] = "application/x-www-form-urlencoded;charset=UTF-8";
      const response = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers,
        body: attachments.length ? form as FormData : form.toString(),
      });
      return { response, payload: await parseResponse(response) };
    };

    let result = await performRequest(await this.ensureToken());
    if ((result.response.status === 401 || result.response.status === 403) && account && password) {
      this.token = undefined;
      result = await performRequest(await this.login());
    }
    const { response } = result;
    let payload = result.payload;
    // PATH_INFO .json responses wrap the controller JSON in {status,data},
    // with data itself being a JSON string.
    if (isObject(payload) && typeof payload.data === "string") {
      try { payload = JSON.parse(payload.data); } catch { /* keep the outer payload for diagnostics */ }
    }
    if (!response.ok) throw new Error(`ZenTao HTTP ${response.status}: ${JSON.stringify(payload)}`);
    if (isEmptyFormResponse(payload)) return { _emptyResponse: true, httpStatus: response.status };
    if (isObject(payload) && (payload.result === "fail" || payload.status === "fail" || payload.error)) {
      throw new Error(`ZenTao form error: ${JSON.stringify(payload.message ?? payload.error ?? payload)}`);
    }
    // ZenTao wraps permission redirects in an HTTP-200 JSON envelope. Treat
    // this as a hard failure instead of reporting a mutation that never ran.
    if (isObject(payload) && typeof payload.locate === "string" && /\/user-deny-/i.test(payload.locate)) {
      throw new Error(`ZenTao permission denied: ${payload.locate}`);
    }
    return payload;
  }
}

async function parseResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return { error: `Empty response (HTTP ${response.status})` };
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`ZenTao returned non-JSON data: ${text.slice(0, 200)}`);
  }
}

const client = new ZentaoClient();
const server = new McpServer({ name: "zentao-v1-mcp", version: "0.8.5" });

function jsonResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function toolError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

async function safe<T>(fn: () => Promise<T>) {
  try {
    return jsonResult(await fn());
  } catch (error) {
    return toolError(error);
  }
}

const pageInput = {
  page: z.number().int().min(1).optional().default(1),
  limit: z.number().int().min(1).max(1000).optional().default(100),
};

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getItems(payload: unknown, key: string): JsonObject[] {
  const value = isObject(payload) ? payload[key] : payload;
  return Array.isArray(value) ? value.filter(isObject) : [];
}

function getPositiveId(value: JsonObject, key = "id"): number | undefined {
  const id = value[key];
  if (typeof id === "number" && Number.isInteger(id) && id > 0) return id;
  if (typeof id === "string" && /^\d+$/.test(id) && Number(id) > 0) return Number(id);
  return undefined;
}

function getName(value: JsonObject): string | undefined {
  return typeof value.name === "string" ? value.name : undefined;
}

function getAssignedAccount(task: JsonObject): string | undefined {
  if (typeof task.assignedTo === "string") return task.assignedTo;
  if (isObject(task.assignedTo) && typeof task.assignedTo.account === "string") return task.assignedTo.account;
  return undefined;
}

const finishedBugStatuses = new Set(["resolved", "closed"]);

function bugMatches(bug: JsonObject, options: { assignedTo?: string; statuses?: string[]; includeFinished: boolean; keyword?: string }): boolean {
  if (options.assignedTo && getAssignedAccount(bug) !== options.assignedTo) return false;
  const status = typeof bug.status === "string" ? bug.status : "";
  if (options.statuses?.length && !options.statuses.includes(status)) return false;
  if (!options.statuses?.length && !options.includeFinished && finishedBugStatuses.has(status)) return false;
  if (options.keyword) {
    const needle = options.keyword.toLocaleLowerCase();
    const searchable = [bug.id, bug.title, bug.keywords, bug.productName, bug.projectName, bug.executionName]
      .filter((value) => value !== undefined && value !== null)
      .join(" ")
      .toLocaleLowerCase();
    if (!searchable.includes(needle)) return false;
  }
  return true;
}

const finishedTaskStatuses = new Set(["done", "closed", "cancel", "cancelled"]);

function taskMatches(task: JsonObject, options: { assignedTo?: string; statuses?: string[]; includeFinished: boolean }): boolean {
  if (options.assignedTo && getAssignedAccount(task) !== options.assignedTo) return false;
  const status = typeof task.status === "string" ? task.status : "";
  if (options.statuses?.length && !options.statuses.includes(status)) return false;
  if (!options.statuses?.length && !options.includeFinished && finishedTaskStatuses.has(status)) return false;
  return true;
}

async function mapConcurrent<T, R>(items: T[], concurrency: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await mapper(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

type TaskQueryOptions = {
  assignedTo?: string;
  statuses?: string[];
  includeFinished: boolean;
  executionLimit: number;
  taskLimit: number;
  concurrency: number;
};

async function aggregateProjectTasks(project: JsonObject, options: TaskQueryOptions) {
  const projectId = getPositiveId(project);
  if (!projectId) return { tasks: [] as JsonObject[], errors: [`项目缺少有效 ID：${JSON.stringify(project)}`], executionCount: 0 };

  const executionPayload = await client.request(`/api.php/v1/projects/${projectId}/executions`, {
    query: { page: 1, limit: options.executionLimit },
  });
  const executions = getItems(executionPayload, "executions");
  const errors: string[] = [];
  const taskGroups = await mapConcurrent(executions, options.concurrency, async (execution) => {
    const executionId = getPositiveId(execution);
    if (!executionId) {
      errors.push(`项目 ${projectId} 中的执行缺少有效 ID`);
      return [];
    }
    try {
      const taskPayload = await client.request(`/api.php/v1/executions/${executionId}/tasks`, {
        query: { page: 1, limit: options.taskLimit },
      });
      return getItems(taskPayload, "tasks")
        .filter((task) => taskMatches(task, options))
        .map((task) => ({
          ...task,
          _context: {
            projectId,
            projectName: getName(project),
            executionId,
            executionName: getName(execution),
          },
        }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`执行 ${executionId} 查询失败：${message}`);
      return [];
    }
  });
  return { tasks: taskGroups.flat(), errors, executionCount: executions.length };
}

const taskStatusSchema = z.array(z.enum(["wait", "doing", "pause", "done", "closed", "cancel", "cancelled"])).max(20).optional();
const bugStatusSchema = z.array(z.enum(["active", "resolved", "closed"])).max(10).optional();
const taskAggregationInput = {
  assignedTo: z.string().min(1).optional(),
  statuses: taskStatusSchema,
  includeFinished: z.boolean().optional().default(false),
  executionLimit: z.number().int().min(1).max(1000).optional().default(100),
  taskLimit: z.number().int().min(1).max(1000).optional().default(1000),
  concurrency: z.number().int().min(1).max(10).optional().default(4),
};
const taskTypeAliases: Record<string, string> = {
  "设计": "design", "规划": "design", "开发": "devel", "需求": "request", "测试": "test", "研究": "study",
  "讨论": "discuss", "界面": "ui", "事务": "affair", "其他": "misc",
};
const taskTypeSchema = z.enum([
  "design", "devel", "request", "test", "study", "discuss", "ui", "affair", "misc",
  "设计", "规划", "开发", "需求", "测试", "研究", "讨论", "界面", "事务", "其他",
]).transform((value) => taskTypeAliases[value] ?? value);
const taskModeSchema = z.enum(["linear", "multi"]).optional().default("linear");
const taskAfterSchema = z.enum(["continueAdding", "toTaskList", "toStoryList"]).optional().default("continueAdding");
const dateTimeSchema = z.string().min(1);
const writeGuardSchema = {
  dryRun: z.boolean().optional().default(true),
  confirm: z.boolean().optional().default(false),
};
const storyCategoryAliases: Record<string, string> = {
  "功能": "feature", "接口": "interface", "性能": "performance", "安全": "safe",
  "体验": "experience", "改进": "improve", "其他": "other",
};
const storyCategorySchema = z.enum([
  "feature", "interface", "performance", "safe", "experience", "improve", "other",
  "功能", "接口", "性能", "安全", "体验", "改进", "其他",
]).transform((value) => storyCategoryAliases[value] ?? value);
const storyReviewResultSchema = z.enum(["pass", "revert", "clarify", "reject"]);
const storyClosedReasonSchema = z.enum(["done", "subdivided", "duplicate", "postponed", "willnotdo", "cancel", "bydesign"]);
const bugTypeAliases: Record<string, string> = {
  "代码错误": "codeerror", "配置相关": "config", "安装部署": "install", "安全相关": "security",
  "性能问题": "performance", "标准规范": "standard", "测试脚本": "automation", "设计缺陷": "designdefect", "其他": "others",
};
// Keep unknown values for deployment-specific Bug type options instead of rejecting them locally.
const bugTypeSchema = z.string().min(1).transform((value) => bugTypeAliases[value] ?? value);
const bugResolutionSchema = z.enum(["bydesign", "duplicate", "external", "fixed", "notrepro", "postponed", "willnotfix", "tostory"]);

function compactBody(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

function isEmptyFormResponse(value: unknown): boolean {
  return isObject(value) && typeof value.error === "string" && /^Empty response \(HTTP 2\d\d\)$/.test(value.error);
}

const bugStepHeadingPattern = /【(现象|重现步骤|复现步骤|步骤|结果|期望|期望结果|背景|备注)】/g;

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;").replace(/'/g, "&#39;");
}

function formatBugText(value: string): string {
  return escapeHtml(value.trim()).replace(/\n+/g, "<br>");
}

function numberedBugSteps(value: string): string[] | undefined {
  const markerPattern = /(?:^|[;；\n])\s*(\d{1,2})[.、)）]\s*/g;
  const markers = [...value.matchAll(markerPattern)];
  if (!markers.length || Number(markers[0][1]) !== 1) return undefined;

  const items: string[] = [];
  for (let index = 0; index < markers.length; index += 1) {
    const marker = markers[index];
    const start = (marker.index ?? 0) + marker[0].length;
    const end = markers[index + 1]?.index ?? value.length;
    const item = value.slice(start, end).replace(/^[;；\s]+|[;；\s]+$/g, "").trim();
    if (item) items.push(item);
  }
  return items.length ? items : undefined;
}

function formatBugStepSection(label: string, value: string): string {
  const content = value.trim();
  const steps = numberedBugSteps(content);
  if (steps) {
    return `<p><strong>【${escapeHtml(label)}】</strong></p><ol>${steps.map((step) => `<li>${formatBugText(step)}</li>`).join("")}</ol>`;
  }
  return `<p><strong>【${escapeHtml(label)}】</strong>${content ? ` ${formatBugText(content)}` : ""}</p>`;
}

/** Normalize plain Bug descriptions into readable HTML for ZenTao's steps field. */
function formatBugSteps(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const text = value.replace(/\r\n?/g, "\n").trim();
  if (!text) return text;
  if (/<\/?[a-z][^>]*>/i.test(text)) return text;

  const headings = [...text.matchAll(bugStepHeadingPattern)];
  if (!headings.length) {
    const steps = numberedBugSteps(text);
    if (steps) return `<ol>${steps.map((step) => `<li>${formatBugText(step)}</li>`).join("")}</ol>`;
    return text.split(/\n{2,}/).map((paragraph) => `<p>${formatBugText(paragraph)}</p>`).join("");
  }

  const sections: string[] = [];
  const prefix = text.slice(0, headings[0].index ?? 0).trim();
  if (prefix) sections.push(`<p>${formatBugText(prefix)}</p>`);
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index];
    const start = (heading.index ?? 0) + heading[0].length;
    const end = headings[index + 1]?.index ?? text.length;
    sections.push(formatBugStepSection(heading[1], text.slice(start, end)));
  }
  return sections.join("");
}

function usesBugFormController(fields: Record<string, unknown>): boolean {
  if (fields.branch !== undefined && Number(fields.branch) !== 0) return true;
  return ["plan", "deadline", "consumed", "estimate", "notifyEmail", "feedbackBy", "os", "browser", "case", "testtask"]
    .some((field) => fields[field] !== undefined);
}

function bugCreateFormEndpoint(product: number, branch: number | undefined): string {
  const branchPart = branch === undefined || branch === 0 ? "" : String(branch);
  return `/bug-create-${product}-${branchPart}-from=global.html`;
}

function bugEditFormEndpoint(id: number): string {
  return `/bug-edit-${id}.html`;
}

function entityFromPayload(payload: unknown, key: string): JsonObject {
  if (!isObject(payload)) throw new Error(`禅道返回了无效的 ${key} 数据。`);
  return isObject(payload[key]) ? payload[key] : payload;
}

function scalarValue(value: unknown): string | number | undefined {
  if (typeof value === "string" || typeof value === "number") return value;
  if (isObject(value)) {
    if (typeof value.id === "number" || typeof value.id === "string") return value.id;
    if (typeof value.account === "string") return value.account;
  }
  return undefined;
}

function listValues(value: unknown): Array<string | number> | undefined {
  if (Array.isArray(value)) {
    const values = value.map(scalarValue).filter((item): item is string | number => item !== undefined && item !== "");
    return values.length ? values : [];
  }
  if (typeof value === "string") {
    if (!value.trim()) return [];
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
  if (isObject(value)) {
    const scalar = scalarValue(value);
    if (scalar !== undefined && scalar !== "") return [scalar];
    return Object.keys(value).filter((key) => key !== "" && key !== "0");
  }
  const scalar = scalarValue(value);
  return scalar === undefined || scalar === "" ? undefined : [scalar];
}

function currentField(story: JsonObject, ...keys: string[]): unknown {
  for (const key of keys) if (story[key] !== undefined && story[key] !== null) return story[key];
  return undefined;
}

function localDateAfterDays(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toLocaleDateString("en-CA");
}

function localDateAfterDaysFrom(dateText: string, days: number): string {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(dateText) ? new Date(`${dateText}T00:00:00`) : new Date();
  if (Number.isNaN(date.getTime())) return localDateAfterDays(days);
  date.setDate(date.getDate() + days);
  return date.toLocaleDateString("en-CA");
}

function localDateTime(date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}

function numberField(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

async function getTaskForLifecycle(id: number): Promise<JsonObject> {
  const payload = await client.request(`/api.php/v1/tasks/${id}`);
  return entityFromPayload(payload, "task");
}

function taskHours(task: JsonObject): { consumed?: number; left?: number } {
  return {
    consumed: numberField(task.consumed),
    left: numberField(task.left),
  };
}

function effortItems(payload: unknown): JsonObject[] {
  const items: JsonObject[] = [];
  const visited = new Set<unknown>();
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isObject(value) || visited.has(value)) return;
    visited.add(value);
    const id = getPositiveId(value);
    if (id && (value.objectID !== undefined || value.task !== undefined || value.consumed !== undefined)) items.push(value);
    for (const key of ["effort", "efforts", "data"]) visit(value[key]);
  };
  visit(payload);
  return items;
}

async function getTaskEfforts(taskId: number): Promise<JsonObject[]> {
  return effortItems(await client.request(`/api.php/v1/tasks/${taskId}/estimate`));
}

async function getTaskEffort(taskId: number, effortId: number): Promise<JsonObject> {
  const effort = (await getTaskEfforts(taskId)).find((item) => getPositiveId(item) === effortId);
  if (!effort) throw new Error(`工时 #${effortId} 不属于任务 #${taskId}，或当前账号无法读取该工时。`);
  const objectId = numberField(effort.objectID ?? effort.task ?? effort.taskID);
  if (objectId !== undefined && objectId !== taskId) {
    throw new Error(`安全校验失败：工时 #${effortId} 的归属任务是 #${objectId}，不是指定任务 #${taskId}。`);
  }
  return effort;
}

function sameEffortField(effort: JsonObject, field: string, expected: string | number): boolean {
  if (typeof expected === "number") return numberField(effort[field]) === expected;
  return String(effort[field] ?? "") === expected;
}

async function verifyTaskEffort(taskId: number, effortId: number, expected: Record<string, string | number>): Promise<JsonObject> {
  const effort = await getTaskEffort(taskId, effortId);
  const mismatches = Object.entries(expected).filter(([field, value]) => !sameEffortField(effort, field, value));
  if (mismatches.length) {
    const details = mismatches.map(([field, value]) => `${field}: 期望 ${JSON.stringify(value)}，实际 ${JSON.stringify(effort[field])}`).join("；");
    throw new Error(`工时 #${effortId} 已提交，但回读校验未通过：${details}`);
  }
  return effort;
}

async function verifyTaskEffortDeleted(taskId: number, effortId: number): Promise<void> {
  const remaining = await getTaskEfforts(taskId);
  if (remaining.some((item) => getPositiveId(item) === effortId)) {
    throw new Error(`删除工时 #${effortId} 的请求已提交，但回读仍能找到该工时；为避免误报成功，MCP 将其视为失败。`);
  }
}

async function findCreatedBug(product: number, title: string): Promise<JsonObject | undefined> {
  const payload = await client.request(`/api.php/v1/products/${product}/bugs`, {
    query: { page: 1, limit: 100, order: "id_desc" },
  });
  const bugs = getItems(payload, "bugs");
  return bugs.find((bug) => bug.title === title && (!account || accountOf(bug.openedBy) === account));
}

function payloadId(payload: unknown): number | undefined {
  if (isObject(payload)) {
    const direct = getPositiveId(payload);
    if (direct) return direct;
    for (const key of ["bug", "data", "result"]) {
      const nested = payloadId(payload[key]);
      if (nested) return nested;
    }
  }
  return undefined;
}

async function getBugById(id: number): Promise<JsonObject> {
  return entityFromPayload(await client.request(`/api.php/v1/bugs/${id}`), "bug");
}

function assertBugFields(current: JsonObject, requested: Record<string, unknown>): void {
  const mismatches = bugFieldMismatches(current, requested);
  if (mismatches.length) throw new Error(`Bug 已提交，但回读校验未通过：${mismatches.join("；")}`);
}

function sameBugField(current: JsonObject, key: string, requested: unknown): boolean {
  if (requested === undefined) return true;
  const actual = currentField(current, key);
  if (Array.isArray(requested)) return JSON.stringify(listValues(actual) ?? []) === JSON.stringify(requested);
  if (typeof requested === "number") return numberField(Array.isArray(actual) ? actual[0] : scalarValue(actual)) === requested;
  if (key === "steps" && typeof requested === "string") return String(actual ?? "") === String(formatBugSteps(requested) ?? "");
  if (key === "assignedTo" && typeof requested === "string") return accountOf(actual) === requested;
  if (key === "openedBuild" && typeof requested === "string" && Array.isArray(actual)) return String(scalarValue(actual[0]) ?? "") === requested;
  return String(actual ?? "") === String(requested);
}

function bugFieldMismatches(current: JsonObject, requested: Record<string, unknown>): string[] {
  return Object.entries(requested)
    .filter(([key, value]) => value !== undefined && !sameBugField(current, key, value))
    .map(([key, value]) => `${key}: 期望 ${JSON.stringify(value)}，实际 ${JSON.stringify(currentField(current, key))}`);
}

async function previewOrRun(action: string, endpoint: string, method: string, body: Record<string, unknown> | undefined, dryRun: boolean, confirm: boolean): Promise<unknown> {
  if (dryRun !== false || confirm !== true) {
    return { dryRun: true, action, method, endpoint, body, message: "预览模式：确认内容后设置 dryRun=false 且 confirm=true 执行。" };
  }
  return client.request(endpoint, { method, body });
}

function accountOf(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (isObject(value) && typeof value.account === "string") return value.account;
  return undefined;
}

async function assertOwnedObject(kind: "story" | "task" | "bug", id: number, expectedTitle: string, titleField: "title" | "name" = "title") {
  if (!account) throw new Error("安全校验失败：未配置 ZENTAO_ACCOUNT，禁止删除对象。");
  const plural = kind === "story" ? "stories" : kind === "task" ? "tasks" : "bugs";
  const payload = await client.request(`/api.php/v1/${plural}/${id}`);
  if (!isObject(payload)) throw new Error(`安全校验失败：${kind} #${id} 返回无效数据。`);
  const object = isObject(payload[kind]) ? payload[kind] : payload;
  const actualTitle = object[titleField];
  const openedBy = accountOf(object.openedBy);
  if (actualTitle !== expectedTitle) throw new Error(`安全校验失败：${kind} #${id} 标题与 expectedName/expectedTitle 不完全一致，拒绝删除。`);
  if (openedBy !== account) throw new Error(`安全校验失败：${kind} #${id} 不是当前账号 ${account} 创建的，拒绝删除。`);
  return object;
}

server.registerTool("zentao_setup_status", {
  description: "检查 zentao-v1 是否已配置。未配置时返回安全初始化步骤；不返回密码或 Token。",
}, async () => jsonResult(configured ? {
  configured: true,
  url: baseUrl,
  authentication: configuredToken && account && password ? "token-with-password-fallback" : configuredToken ? "token" : "account-password",
  account: account ?? "token-authenticated",
  restartRequiredAfterChanges: true,
} : {
  configured: false,
  setupRequired: true,
  setupCommand,
  instructions: [
    "在本机终端中运行 setupCommand。",
    "不要在聊天中发送密码；配置脚本会使用隐藏输入。",
    "连接验证成功后，脚本会写入当前用户的 .config\\zentao-v1\\credentials.json。",
    "完全退出并重新启动 Claude Code。",
  ],
  securityNote: "配置脚本会将账号密码和 Token 保存到当前用户的 credentials.json；密码用于 Token 失效后自动重新登录。该文件包含明文凭据，必须仅允许当前 Windows 用户读取。",
}));

server.registerTool("zentao_whoami", {
  description: "验证禅道 REST API v1 登录并返回当前用户资料。",
}, async () => safe(async () => ({ ok: true, url: baseUrl, ...await client.request("/api.php/v1/user") as JsonObject })));

server.registerTool("zentao_list_products", {
  description: "列出禅道产品。",
  inputSchema: pageInput,
}, async ({ page, limit }) => safe(() => client.request("/api.php/v1/products", { query: { page, limit } })));

server.registerTool("zentao_list_programs", {
  description: "列出禅道项目集。",
  inputSchema: { limit: pageInput.limit },
}, async ({ limit }) => safe(() => client.request("/api.php/v1/programs", { query: { limit } })));

server.registerTool("zentao_list_projects", {
  description: "列出禅道项目。",
  inputSchema: pageInput,
}, async ({ page, limit }) => safe(() => client.request("/api.php/v1/projects", { query: { page, limit } })));

server.registerTool("zentao_get_project", {
  description: "按 ID 获取禅道项目详情。",
  inputSchema: { id: z.number().int().positive() },
}, async ({ id }) => safe(() => client.request(`/api.php/v1/projects/${id}`)));

server.registerTool("zentao_list_executions", {
  description: "列出禅道执行。",
  inputSchema: pageInput,
}, async ({ page, limit }) => safe(() => client.request("/api.php/v1/executions", { query: { page, limit } })));

server.registerTool("zentao_list_project_executions", {
  description: "按项目列出执行。禅道 REST API v1 的执行列表应优先通过项目查询。",
  inputSchema: { project: z.number().int().positive(), ...pageInput },
}, async ({ project, page, limit }) => safe(() => client.request(`/api.php/v1/projects/${project}/executions`, { query: { page, limit } })));

server.registerTool("zentao_get_execution", {
  description: "按 ID 获取禅道执行详情。",
  inputSchema: { id: z.number().int().positive() },
}, async ({ id }) => safe(() => client.request(`/api.php/v1/executions/${id}`)));

server.registerTool("zentao_list_bugs", {
  description: "按产品查询并在 MCP 内筛选 Bug。支持负责人、状态和标题/ID关键词；默认排除已解决和已关闭，只返回匹配结果，不要把全量 Bug 导出到文件再筛选。查询当前用户的 Bug 应优先调用 zentao_list_my_bugs。",
  inputSchema: {
    product: z.number().int().positive(),
    ...pageInput,
    assignedTo: z.string().min(1).optional(),
    statuses: bugStatusSchema,
    includeFinished: z.boolean().optional().default(false),
    keyword: z.string().min(1).optional().describe("匹配 Bug ID、标题、关键词或项目/执行名称"),
    maxResults: z.number().int().min(1).max(200).optional().default(50),
  },
}, async ({ product, page, limit, assignedTo, statuses, includeFinished, keyword, maxResults }) => safe(async () => {
  const payload = await client.request(`/api.php/v1/products/${product}/bugs`, { query: { page, limit } });
  const bugs = getItems(payload, "bugs").filter((bug) => bugMatches(bug, { assignedTo, statuses, includeFinished, keyword })).slice(0, maxResults);
  return { product, page, limit, total: bugs.length, bugs };
}));

server.registerTool("zentao_list_my_bugs", {
  description: "直接查询禅道“我的地盘”中分配给当前登录用户的 Bug，不扫描产品、不拉取全量 Bug、不写临时文件。默认只返回未解决 Bug，可按状态和标题/ID关键词筛选。凡是“我的 Bug/分配给我的 Bug/我有哪些 Bug”都应直接调用本工具。",
  inputSchema: {
    statuses: bugStatusSchema,
    includeFinished: z.boolean().optional().default(false),
    keyword: z.string().min(1).optional().describe("匹配 Bug ID、标题、关键词或项目/执行名称"),
    page: z.number().int().min(1).optional().default(1),
    limit: z.number().int().min(1).max(1000).optional().default(100),
    maxResults: z.number().int().min(1).max(200).optional().default(50),
    order: z.string().min(1).optional().default("id_desc"),
  },
}, async ({ statuses, includeFinished, keyword, page, limit, maxResults, order }) => safe(async () => {
  const payload = await client.request("/api.php/v1/user", {
    query: { fields: "bug", type: "assignedTo", page, limit, order },
  });
  if (!isObject(payload)) throw new Error("禅道 /api.php/v1/user 返回了无效数据");
  const profile = isObject(payload.profile) ? payload.profile : undefined;
  const bugResult = isObject(payload.bug) ? payload.bug : undefined;
  if (!bugResult || !Array.isArray(bugResult.bugs)) {
    throw new Error("禅道 18.6 未返回 bug 字段。请确认当前账号拥有“我的地盘 → Bug”权限");
  }
  const bugs = bugResult.bugs.filter(isObject).filter((bug) => bugMatches(bug, { statuses, includeFinished, keyword })).slice(0, maxResults);
  return {
    account: profile && typeof profile.account === "string" ? profile.account : account ?? "token-authenticated",
    realname: profile && typeof profile.realname === "string" ? profile.realname : undefined,
    page,
    limit,
    reportedTotal: typeof bugResult.total === "number" ? bugResult.total : bugs.length,
    total: bugs.length,
    bugs,
  };
}));

server.registerTool("zentao_get_bug", {
  description: "按 ID 获取禅道 Bug 详情。",
  inputSchema: { id: z.number().int().positive() },
}, async ({ id }) => safe(() => client.request(`/api.php/v1/bugs/${id}`)));

server.registerTool("zentao_list_stories", {
  description: "按产品列出禅道需求。",
  inputSchema: { product: z.number().int().positive(), ...pageInput },
}, async ({ product, page, limit }) => safe(() => client.request(`/api.php/v1/products/${product}/stories`, { query: { page, limit } })));

server.registerTool("zentao_get_story", {
  description: "按 ID 获取禅道需求详情。",
  inputSchema: { id: z.number().int().positive() },
}, async ({ id }) => safe(() => client.request(`/api.php/v1/stories/${id}`)));

server.registerTool("zentao_list_modules", {
  description: "列出需求、任务、Bug 或用例可用模块。创建前缺少模块 ID 时调用；不要通过扫描需求/任务来猜模块。",
  inputSchema: {
    type: z.enum(["story", "task", "bug", "case"]),
    id: z.number().int().positive().describe("story/bug/case 传产品 ID；task 传执行 ID"),
  },
}, async ({ type, id }) => safe(() => client.request("/api.php/v1/modules", { query: { type, id } })));

server.registerTool("zentao_list_tasks", {
  description: "按执行列出禅道任务，可按负责人、状态过滤，默认排除已完成、已关闭和已取消任务。",
  inputSchema: {
    execution: z.number().int().positive(),
    ...pageInput,
    assignedTo: z.string().min(1).optional(),
    statuses: taskStatusSchema,
    includeFinished: z.boolean().optional().default(false),
  },
}, async ({ execution, page, limit, assignedTo, statuses, includeFinished }) => safe(async () => {
  const payload = await client.request(`/api.php/v1/executions/${execution}/tasks`, { query: { page, limit } });
  const tasks = getItems(payload, "tasks").filter((task) => taskMatches(task, { assignedTo, statuses, includeFinished }));
  return { execution, page, limit, total: tasks.length, tasks };
}));

server.registerTool("zentao_list_project_tasks", {
  description: "查询一个项目下所有执行的任务并聚合，可按负责人和状态过滤。默认只返回未完成任务。",
  inputSchema: { project: z.number().int().positive(), ...taskAggregationInput },
}, async ({ project, ...options }) => safe(async () => {
  let projectInfo: JsonObject = { id: project };
  try {
    const detail = await client.request(`/api.php/v1/projects/${project}`);
    if (isObject(detail)) projectInfo = isObject(detail.project) ? detail.project : detail;
  } catch {
    // 项目详情不是聚合任务的必要条件；无权限或路由差异时继续使用项目 ID。
  }
  const result = await aggregateProjectTasks(projectInfo, options);
  return { project, executionCount: result.executionCount, total: result.tasks.length, tasks: result.tasks, errors: result.errors };
}));

server.registerTool("zentao_list_my_tasks", {
  description: "直接查询禅道“我的地盘”中分配给当前登录用户的任务，不扫描项目或执行。默认只返回未完成任务。",
  inputSchema: {
    statuses: taskStatusSchema,
    includeFinished: z.boolean().optional().default(false),
    page: z.number().int().min(1).optional().default(1),
    limit: z.number().int().min(1).max(1000).optional().default(100),
    order: z.string().min(1).optional().default("id_desc"),
  },
}, async ({ statuses, includeFinished, page, limit, order }) => safe(async () => {
  const payload = await client.request("/api.php/v1/user", {
    query: { fields: "task", type: "assignedTo", page, limit, order },
  });
  if (!isObject(payload)) throw new Error("禅道 /api.php/v1/user 返回了无效数据");
  const profile = isObject(payload.profile) ? payload.profile : undefined;
  const taskResult = isObject(payload.task) ? payload.task : undefined;
  if (!taskResult || !Array.isArray(taskResult.tasks)) {
    throw new Error("禅道 18.6 未返回 task 字段。请确认当前账号拥有“我的地盘 → 任务”权限");
  }
  const tasks = taskResult.tasks.filter(isObject).filter((task) => taskMatches(task, { statuses, includeFinished }));
  return {
    account: profile && typeof profile.account === "string" ? profile.account : account ?? "token-authenticated",
    realname: profile && typeof profile.realname === "string" ? profile.realname : undefined,
    page,
    limit,
    reportedTotal: typeof taskResult.total === "number" ? taskResult.total : tasks.length,
    total: tasks.length,
    tasks,
  };
}));

server.registerTool("zentao_get_task", {
  description: "按 ID 获取禅道任务详情。",
  inputSchema: { id: z.number().int().positive() },
}, async ({ id }) => safe(() => client.request(`/api.php/v1/tasks/${id}`)));

server.registerTool("zentao_update_task", {
  description: "修改禅道任务字段。默认只生成预览；只有 confirm=true 且 dryRun=false 才会真正修改。",
  inputSchema: {
    id: z.number().int().positive(),
    name: z.string().min(1).optional(),
    assignedTo: z.string().min(1).optional(),
    type: taskTypeSchema.optional(),
    estStarted: z.string().date().optional(),
    deadline: z.string().date().optional(),
    module: z.number().int().nonnegative().optional(),
    story: z.number().int().nonnegative().optional(),
    pri: z.number().int().min(1).max(4).optional(),
    estimate: z.number().nonnegative().optional(),
    desc: z.string().optional(),
    mailto: z.array(z.string().min(1)).max(100).optional().describe("抄送账号列表"),
    dryRun: z.boolean().optional().default(true),
    confirm: z.boolean().optional().default(false),
  },
}, async ({ id, dryRun, confirm, ...fields }) => safe(async () => {
  const body = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
  if (!Object.keys(body).length) throw new Error("至少提供一个需要修改的任务字段");
  if (dryRun !== false || confirm !== true) return { dryRun: true, action: "update_task", method: "PUT", endpoint: `/api.php/v1/tasks/${id}`, body, message: "预览模式：设置 dryRun=false 且 confirm=true 才会执行。" };
  return client.request(`/api.php/v1/tasks/${id}`, { method: "PUT", body });
}));

server.registerTool("zentao_update_task_links", {
  description: "独立关联或解除任务与需求的关系。linkStory 设置需求 ID，unlinkStory=true 解除关联；使用禅道 18.6 官方任务 PUT 接口。默认预览。",
  inputSchema: {
    id: z.number().int().positive().describe("任务 ID"),
    linkStory: z.number().int().positive().optional().describe("要关联的需求 ID"),
    unlinkStory: z.boolean().optional().default(false),
    ...writeGuardSchema,
  },
}, async ({ id, linkStory, unlinkStory, dryRun, confirm }) => safe(async () => {
  if (linkStory !== undefined && unlinkStory) throw new Error("linkStory 与 unlinkStory 不能同时提供。");
  if (linkStory === undefined && !unlinkStory) throw new Error("请提供 linkStory，或设置 unlinkStory=true。");
  const body = { story: unlinkStory ? 0 : linkStory };
  return previewOrRun("update_task_links", `/api.php/v1/tasks/${id}`, "PUT", body, dryRun, confirm);
}));

server.registerTool("zentao_record_task_effort", {
  description: "给任务记录一次工时并更新剩余工时。日期、消耗、剩余和工作内容一次提交；默认预览。禅道 18.6 会在剩余工时为 0 时自动完成任务。",
  inputSchema: {
    id: z.number().int().positive(),
    date: z.string().date().describe("工时日期 YYYY-MM-DD，不能晚于今天"),
    consumed: z.number().positive().describe("本次消耗工时，必须大于 0"),
    left: z.number().nonnegative().describe("记录后的预计剩余工时"),
    work: z.string().min(1).describe("本次完成的工作内容"),
    ...writeGuardSchema,
  },
}, async ({ id, date, consumed, left, work, dryRun, confirm }) => safe(async () => {
  const body = { id: [1], dates: [date], consumed: [consumed], left: [left], work: [work], date, objectType: "task", objectID: id };
  return previewOrRun("record_task_effort", `/api.php/v1/tasks/${id}/estimate`, "POST", body, dryRun, confirm);
}));

server.registerTool("zentao_list_task_efforts", {
  description: "列出指定任务的工时记录。只读取该任务的工时，不扫描其他任务。",
  inputSchema: { taskId: z.number().int().positive() },
}, async ({ taskId }) => safe(async () => ({ taskId, efforts: await getTaskEfforts(taskId) })));

server.registerTool("zentao_update_task_effort", {
  description: "编辑指定任务的一条工时记录。执行前会读取并校验工时确实属于 taskId，执行后再次回读核对；默认预览。",
  inputSchema: {
    taskId: z.number().int().positive(),
    effortId: z.number().int().positive(),
    date: z.string().date().optional().describe("工时日期 YYYY-MM-DD，不能晚于今天"),
    consumed: z.number().positive().optional().describe("本次消耗工时，必须大于 0"),
    left: z.number().nonnegative().optional().describe("记录后的预计剩余工时"),
    work: z.string().min(1).optional().describe("工作内容"),
    ...writeGuardSchema,
  },
}, async ({ taskId, effortId, dryRun, confirm, date, consumed, left, work }) => safe(async () => {
  const requested = compactBody({ date, consumed, left, work });
  if (!Object.keys(requested).length) throw new Error("至少提供一个需要修改的工时字段。");
  if (dryRun !== false || confirm !== true) {
    return {
      dryRun: true,
      action: "update_task_effort",
      method: "POST_FORM",
      endpoint: `/task-editEstimate-${effortId}.json`,
      taskId,
      effortId,
      body: requested,
      message: "预览模式：设置 dryRun=false 且 confirm=true 才会执行。",
    };
  }

  const current = await getTaskEffort(taskId, effortId);
  const body = {
    date: date ?? String(current.date ?? ""),
    consumed: consumed ?? numberField(current.consumed),
    left: left ?? numberField(current.left),
    work: work ?? String(current.work ?? ""),
  };
  if (!body.date || body.consumed === undefined || body.left === undefined || !body.work) {
    throw new Error(`工时 #${effortId} 当前记录缺少编辑所需字段，无法安全提交；请先检查工时详情。`);
  }
  const result = await client.formRequest(`/task-editEstimate-${effortId}.json`, body);
  const verifiedBody: Record<string, string | number> = {
    date: body.date,
    consumed: body.consumed,
    left: body.left,
    work: body.work,
  };
  const effort = await verifyTaskEffort(taskId, effortId, verifiedBody);
  return { response: result, verified: true, taskId, effortId, effort };
}));

server.registerTool("zentao_delete_task_effort", {
  description: "删除指定任务的一条工时记录。执行前会读取并校验工时归属，删除后回读确认记录消失；默认预览。禅道会按官方规则同步任务累计工时和状态。",
  inputSchema: {
    taskId: z.number().int().positive(),
    effortId: z.number().int().positive(),
    ...writeGuardSchema,
  },
}, async ({ taskId, effortId, dryRun, confirm }) => safe(async () => {
  if (dryRun !== false || confirm !== true) {
    return {
      dryRun: true,
      action: "delete_task_effort",
      method: "POST_FORM",
      endpoint: `/task-deleteEstimate-${effortId}-yes.json`,
      taskId,
      effortId,
      guard: "执行前确认 effortId 属于 taskId；删除后再次读取任务工时核对。",
      message: "预览模式：设置 dryRun=false 且 confirm=true 才会执行。",
    };
  }

  await getTaskEffort(taskId, effortId);
  const result = await client.formRequest(`/task-deleteEstimate-${effortId}-yes.json`, {});
  await verifyTaskEffortDeleted(taskId, effortId);
  return { response: result, verified: true, taskId, effortId, deleted: true };
}));

server.registerTool("zentao_delete_task", {
  description: "删除任务。执行前会读取任务并校验标题完全一致且创建人为当前账号，防止误删他人任务；默认预览。",
  inputSchema: { id: z.number().int().positive(), expectedName: z.string().min(1), ...writeGuardSchema },
}, async ({ id, expectedName, dryRun, confirm }) => safe(async () => {
  if (dryRun !== false || confirm !== true) return { dryRun: true, action: "delete_task", method: "DELETE", endpoint: `/api.php/v1/tasks/${id}`, guard: { expectedName, mustBeOpenedByCurrentAccount: true } };
  await assertOwnedObject("task", id, expectedName, "name");
  return client.request(`/api.php/v1/tasks/${id}`, { method: "DELETE" });
}));

server.registerTool("zentao_start_task", {
  description: "开始禅道任务。consumed/left 是提交后的累计消耗和剩余工时，不传时由 MCP 读取当前任务值补齐，避免 left=0 导致任务被立即完成。默认只生成预览。",
  inputSchema: {
    id: z.number().int().positive(), assignedTo: z.string().min(1).optional(), realStarted: dateTimeSchema.optional(),
    consumed: z.number().nonnegative().optional(), left: z.number().nonnegative().optional(), comment: z.string().optional(),
    dryRun: z.boolean().optional().default(true), confirm: z.boolean().optional().default(false),
  },
}, async ({ id, dryRun, confirm, ...fields }) => safe(async () => {
  const body = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
  if (dryRun !== false || confirm !== true) return { dryRun: true, action: "start_task", endpoint: `/api.php/v1/tasks/${id}/start`, body, message: "预览模式：设置 dryRun=false 且 confirm=true 才会执行。" };
  const current = taskHours(await getTaskForLifecycle(id));
  const effectiveBody = { ...body, consumed: body.consumed ?? current.consumed, left: body.left ?? current.left };
  if (effectiveBody.consumed === undefined || effectiveBody.left === undefined) throw new Error("无法读取任务当前 consumed/left，请先获取任务详情后重试。");
  if (effectiveBody.left === 0) throw new Error("任务当前剩余工时为 0，开始操作会直接将任务置为完成；如确实要完成，请使用 zentao_finish_task。");
  return client.request(`/api.php/v1/tasks/${id}/start`, { method: "POST", body: effectiveBody });
}));

server.registerTool("zentao_pause_task", {
  description: "暂停禅道任务。默认只生成预览；只有 confirm=true 且 dryRun=false 才会真正执行。",
  inputSchema: { id: z.number().int().positive(), comment: z.string().optional(), dryRun: z.boolean().optional().default(true), confirm: z.boolean().optional().default(false) },
}, async ({ id, dryRun, confirm, comment }) => safe(async () => {
  const body = comment === undefined ? {} : { comment };
  if (dryRun !== false || confirm !== true) return { dryRun: true, action: "pause_task", endpoint: `/api.php/v1/tasks/${id}/pause`, body, message: "预览模式：设置 dryRun=false 且 confirm=true 才会执行。" };
  return client.request(`/api.php/v1/tasks/${id}/pause`, { method: "POST", body });
}));

server.registerTool("zentao_restart_task", {
  description: "继续已暂停的禅道任务。consumed/left 是提交后的累计消耗和剩余工时，不传时由 MCP 读取当前任务值补齐。默认只生成预览。",
  inputSchema: {
    id: z.number().int().positive(), assignedTo: z.string().min(1).optional(), realStarted: dateTimeSchema.optional(),
    consumed: z.number().nonnegative().optional(), left: z.number().nonnegative().optional(), comment: z.string().optional(),
    dryRun: z.boolean().optional().default(true), confirm: z.boolean().optional().default(false),
  },
}, async ({ id, dryRun, confirm, ...fields }) => safe(async () => {
  const body = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
  if (dryRun !== false || confirm !== true) return { dryRun: true, action: "restart_task", endpoint: `/api.php/v1/tasks/${id}/restart`, body, message: "预览模式：设置 dryRun=false 且 confirm=true 才会执行。" };
  const current = taskHours(await getTaskForLifecycle(id));
  const effectiveBody = { ...body, consumed: body.consumed ?? current.consumed, left: body.left ?? current.left };
  if (effectiveBody.consumed === undefined || effectiveBody.left === undefined) throw new Error("无法读取任务当前 consumed/left，请先获取任务详情后重试。");
  if (effectiveBody.left === 0) throw new Error("任务当前剩余工时为 0，恢复操作会直接将任务置为完成；如确实要完成，请使用 zentao_finish_task。");
  return client.request(`/api.php/v1/tasks/${id}/restart`, { method: "POST", body: effectiveBody });
}));

server.registerTool("zentao_finish_task", {
  description: "完成禅道任务。currentConsumed 表示本次新增消耗工时，不是任务累计消耗；MCP 会拒绝超过当前剩余工时的值，避免重复累加。默认只生成预览。",
  inputSchema: {
    id: z.number().int().positive(), currentConsumed: z.number().nonnegative(), assignedTo: z.string().min(1).optional(),
    realStarted: dateTimeSchema.optional(), finishedDate: dateTimeSchema.optional(), comment: z.string().optional(),
    dryRun: z.boolean().optional().default(true), confirm: z.boolean().optional().default(false),
  },
}, async ({ id, dryRun, confirm, ...fields }) => safe(async () => {
  // Give the server one minute of clock-skew tolerance. Some ZenTao 18.6
  // deployments persist realStarted with a slightly later application clock.
  const body = Object.fromEntries(Object.entries({ ...fields, finishedDate: fields.finishedDate ?? localDateTime(new Date(Date.now() + 60_000)) }).filter(([, value]) => value !== undefined));
  if (dryRun !== false || confirm !== true) return { dryRun: true, action: "finish_task", endpoint: `/api.php/v1/tasks/${id}/finish`, body, message: "预览模式：设置 dryRun=false 且 confirm=true 才会执行。" };
  const current = taskHours(await getTaskForLifecycle(id));
  if (current.left !== undefined && body.currentConsumed !== undefined && Number(body.currentConsumed) > current.left) {
    throw new Error(`currentConsumed 是本次新增工时，不能大于当前剩余工时 ${current.left} 小时；如果要完成任务，本次最多填写 ${current.left} 小时，而不是累计工时。`);
  }
  return client.request(`/api.php/v1/tasks/${id}/finish`, { method: "POST", body });
}));

server.registerTool("zentao_close_task", {
  description: "关闭禅道任务。默认只生成预览；只有 confirm=true 且 dryRun=false 才会真正执行。",
  inputSchema: { id: z.number().int().positive(), comment: z.string().optional(), dryRun: z.boolean().optional().default(true), confirm: z.boolean().optional().default(false) },
}, async ({ id, dryRun, confirm, comment }) => safe(async () => {
  const body = comment === undefined ? {} : { comment };
  if (dryRun !== false || confirm !== true) return { dryRun: true, action: "close_task", endpoint: `/api.php/v1/tasks/${id}/close`, body, message: "预览模式：设置 dryRun=false 且 confirm=true 才会执行。" };
  return client.request(`/api.php/v1/tasks/${id}/close`, { method: "POST", body });
}));

server.registerTool("zentao_list_todos", {
  description: "列出当前用户可见的禅道待办。",
  inputSchema: pageInput,
}, async ({ page, limit }) => safe(() => client.request("/api.php/v1/todos", { query: { page, limit } })));

server.registerTool("zentao_get_todo", {
  description: "按 ID 获取禅道待办详情。",
  inputSchema: { id: z.number().int().positive() },
}, async ({ id }) => safe(() => client.request(`/api.php/v1/todos/${id}`)));

server.registerTool("zentao_list_plans", {
  description: "按产品列出产品计划。",
  inputSchema: { product: z.number().int().positive(), ...pageInput },
}, async ({ product, page, limit }) => safe(() => client.request(`/api.php/v1/products/${product}/plans`, { query: { page, limit } })));

server.registerTool("zentao_list_releases", {
  description: "按产品列出产品发布。",
  inputSchema: { product: z.number().int().positive(), ...pageInput },
}, async ({ product, page, limit }) => safe(() => client.request(`/api.php/v1/products/${product}/releases`, { query: { page, limit } })));

server.registerTool("zentao_list_testcases", {
  description: "按产品列出测试用例。",
  inputSchema: { product: z.number().int().positive(), ...pageInput },
}, async ({ product, page, limit }) => safe(() => client.request(`/api.php/v1/products/${product}/testcases`, { query: { page, limit } })));

server.registerTool("zentao_list_testtasks", {
  description: "列出测试单。",
  inputSchema: pageInput,
}, async ({ page, limit }) => safe(() => client.request("/api.php/v1/testtasks", { query: { page, limit } })));

server.registerTool("zentao_list_testsuites", {
  description: "按产品列出测试套件。",
  inputSchema: { product: z.number().int().positive(), ...pageInput },
}, async ({ product, page, limit }) => safe(() => client.request(`/api.php/v1/products/${product}/testsuites`, { query: { page, limit } })));

server.registerTool("zentao_list_doclibs", {
  description: "列出禅道文档库。",
}, async () => safe(() => client.request("/api.php/v1/doclibs")));

server.registerTool("zentao_list_docs", {
  description: "按文档库列出禅道文档。",
  inputSchema: { lib: z.number().int().positive(), ...pageInput },
}, async ({ lib, page, limit }) => safe(() => client.request(`/api.php/v1/doclibs/${lib}/docs`, { query: { page, limit } })));

server.registerTool("zentao_get_doc", {
  description: "按 ID 获取禅道文档详情。",
  inputSchema: { id: z.number().int().positive() },
}, async ({ id }) => safe(() => client.request(`/api.php/v1/docs/${id}`)));

server.registerTool("zentao_list_issues", {
  description: "列出禅道问题。",
  inputSchema: pageInput,
}, async ({ page, limit }) => safe(() => client.request("/api.php/v1/issues", { query: { page, limit } })));

server.registerTool("zentao_list_risks", {
  description: "列出禅道风险。",
  inputSchema: pageInput,
}, async ({ page, limit }) => safe(() => client.request("/api.php/v1/risks", { query: { page, limit } })));

server.registerTool("zentao_create_story", {
  description: "通过禅道 18.x 官方需求表单创建需求。支持产品、模块、计划、指派、来源、评审者、父需求、类别、优先级、预计工时、描述、验收标准、抄送和关键词；默认预览。",
  inputSchema: {
    product: z.number().int().positive(),
    title: z.string().min(1),
    spec: z.string().min(1).describe("需求描述，禅道 18.6 API 必填"),
    pri: z.number().int().min(1).max(4).optional().default(3),
    category: storyCategorySchema.optional().default("feature"),
    module: z.number().int().nonnegative().optional().default(0).describe("产品需求模块 ID；实例要求模块必填时，先用 zentao_list_modules(type=story) 获取"),
    verify: z.string().optional(),
    source: z.string().min(1).optional().describe("来源 key 或当前实例表单中的来源值"),
    sourceNote: z.string().optional().describe("来源备注"),
    assignedTo: z.string().min(1).optional().describe("指派给的禅道账号；不传时使用当前登录账号"),
    reviewer: z.array(z.string().min(1)).max(100).optional().describe("评审者禅道账号列表；传入后进入评审流程，不传则跳过评审"),
    parent: z.number().int().nonnegative().optional().describe("父需求 ID；不传或传 0 表示无父需求"),
    estimate: z.number().nonnegative().optional().default(0),
    plan: z.union([z.number().int().nonnegative(), z.array(z.number().int().nonnegative()).min(1).max(100)]).optional().default(0).describe("计划 ID，或计划 ID 数组"),
    branch: z.number().int().nonnegative().optional().default(0), keywords: z.string().optional(),
    mailto: z.array(z.string().min(1)).max(100).optional(), notifyEmail: z.string().optional(),
    status: z.enum(["draft", "active"]).optional().default("active"),
    ...writeGuardSchema,
  },
}, async ({ product, dryRun, confirm, status, ...fields }) => safe(async () => {
  const planIds = Array.isArray(fields.plan) ? fields.plan : [fields.plan];
  const indexedPlans = Object.fromEntries(planIds.map((plan, index) => [`plans[${index}]`, plan]));
  const reviewers = fields.reviewer?.filter(Boolean) ?? [];
  const endpoint = `/story-create-${product}-${fields.branch ?? 0}-${fields.module}.json`;
  const body = compactBody({
    product,
    module: fields.module,
    "branches[0]": fields.branch,
    "modules[0]": fields.module,
    ...indexedPlans,
    plan: planIds[0],
    assignedTo: fields.assignedTo ?? account ?? "",
    reviewer: reviewers.length ? reviewers : undefined,
    needNotReview: reviewers.length ? undefined : 1,
    parent: fields.parent,
    title: fields.title,
    spec: fields.spec,
    verify: fields.verify,
    source: fields.source,
    sourceNote: fields.sourceNote,
    category: fields.category,
    pri: fields.pri,
    estimate: fields.estimate,
    mailto: fields.mailto,
    notifyEmail: fields.notifyEmail,
    keywords: fields.keywords,
    type: "story",
    status,
  });
  if (dryRun !== false || confirm !== true) {
    return { dryRun: true, action: "create_story", method: "POST", endpoint, body, message: "预览模式：确认内容后设置 dryRun=false 且 confirm=true 执行。" };
  }
  return client.formRequest(endpoint, body);
}));

server.registerTool("zentao_update_story", {
  description: "通过需求变更流程修改标题、描述和验收标准；其他需求字段请使用 zentao_edit_story。默认预览。",
  inputSchema: {
    id: z.number().int().positive(), title: z.string().min(1).optional(), spec: z.string().min(1).optional(), verify: z.string().optional(), comment: z.string().optional(),
    ...writeGuardSchema,
  },
}, async ({ id, dryRun, confirm, title, spec, verify, comment }) => safe(async () => {
  const body = compactBody({ title, spec, verify, comment });
  if (!Object.keys(body).length) throw new Error("至少提供 title、spec、verify 或 comment 中的一个字段。");
  const endpoint = `/api.php/v1/stories/${id}/change`;
  if (dryRun !== false || confirm !== true) {
    return { dryRun: true, action: "update_story", method: "POST", endpoint, body, message: "预览模式：确认后设置 dryRun=false 且 confirm=true 执行需求变更。" };
  }
  const current = entityFromPayload(await client.request(`/api.php/v1/stories/${id}`), "story");
  const mergedBody = compactBody({ title: title ?? current.title, spec: spec ?? current.spec, verify: verify ?? current.verify, comment });
  return client.request(endpoint, { method: "POST", body: mergedBody });
}));

server.registerTool("zentao_edit_story", {
  description: "按禅道 18.x 官方 story-edit 控制器修改需求完整信息，包括产品、模块、分类、优先级、预计工时、计划、评审人、来源、抄送和关键词。默认预览。指派请使用 zentao_assign_story。",
  inputSchema: {
    id: z.number().int().positive(),
    title: z.string().min(1).optional(),
    spec: z.string().optional(),
    verify: z.string().optional(),
    product: z.number().int().positive().optional(),
    module: z.number().int().nonnegative().optional(),
    parent: z.number().int().nonnegative().optional(),
    plan: z.union([z.number().int().nonnegative(), z.array(z.number().int().nonnegative()).max(100)]).optional(),
    reviewer: z.array(z.string().min(1)).max(100).optional(),
    type: z.enum(["story", "requirement"]).optional(),
    source: z.string().optional(),
    sourceNote: z.string().optional(),
    category: storyCategorySchema.optional(),
    pri: z.number().int().min(1).max(4).optional(),
    estimate: z.number().nonnegative().optional(),
    stage: z.string().min(1).optional(),
    mailto: z.array(z.string().min(1)).max(100).optional(),
    keywords: z.string().optional(),
    notifyEmail: z.string().optional(),
    comment: z.string().optional(),
    ...writeGuardSchema,
  },
}, async ({ id, dryRun, confirm, ...changes }) => safe(async () => {
  const requested = compactBody(changes);
  if (!Object.keys(requested).length) throw new Error("至少提供一个需要修改的需求字段。");
  const endpoint = `/story-edit-${id}.json`;
  if (dryRun !== false || confirm !== true) {
    return {
      dryRun: true,
      action: "edit_story",
      method: "POST_FORM",
      endpoint,
      changes: requested,
      message: "预览模式：执行时会先读取当前需求、合并未修改字段，再通过 ZenTao 18.6 story-edit 控制器提交。设置 dryRun=false 且 confirm=true 执行。",
    };
  }

  const story = entityFromPayload(await client.request(`/api.php/v1/stories/${id}`), "story");
  const merged = compactBody({
    product: changes.product ?? scalarValue(currentField(story, "product")),
    branch: scalarValue(currentField(story, "branch")),
    module: changes.module ?? scalarValue(currentField(story, "module")),
    parent: changes.parent ?? scalarValue(currentField(story, "parent")),
    plan: changes.plan ?? listValues(currentField(story, "plan")) ?? scalarValue(currentField(story, "plan")),
    reviewer: changes.reviewer ?? listValues(currentField(story, "reviewer", "reviewers")),
    type: changes.type ?? scalarValue(currentField(story, "type")),
    title: changes.title ?? currentField(story, "title"),
    spec: changes.spec ?? currentField(story, "spec"),
    verify: changes.verify ?? currentField(story, "verify"),
    source: changes.source ?? currentField(story, "source"),
    sourceNote: changes.sourceNote ?? currentField(story, "sourceNote"),
    category: changes.category ?? currentField(story, "category"),
    pri: changes.pri ?? scalarValue(currentField(story, "pri")),
    estimate: changes.estimate ?? scalarValue(currentField(story, "estimate")),
    stage: changes.stage ?? currentField(story, "stage"),
    mailto: changes.mailto ?? listValues(currentField(story, "mailto")),
    keywords: changes.keywords ?? currentField(story, "keywords"),
    notifyEmail: changes.notifyEmail ?? currentField(story, "notifyEmail"),
    assignedTo: accountOf(currentField(story, "assignedTo")) ?? "",
    linkStories: listValues(currentField(story, "linkStories")),
    linkRequirements: listValues(currentField(story, "linkRequirements")),
    childStories: listValues(currentField(story, "childStories")),
    lastEditedDate: currentField(story, "lastEditedDate"),
    comment: changes.comment,
  });
  return client.formRequest(endpoint, merged);
}));

server.registerTool("zentao_assign_story", {
  description: "使用禅道 18.6 官方需求指派接口把需求指派给指定账号。默认预览。",
  inputSchema: {
    id: z.number().int().positive(),
    assignedTo: z.string().min(1).describe("禅道账号，例如 hehaitao；不是显示姓名"),
    comment: z.string().optional(),
    ...writeGuardSchema,
  },
}, async ({ id, assignedTo, comment, dryRun, confirm }) => safe(() =>
  previewOrRun("assign_story", `/api.php/v1/stories/${id}/assign`, "POST", compactBody({ assignedTo, comment }), dryRun, confirm)
));

server.registerTool("zentao_recall_story", {
  description: "使用禅道 18.6 官方 recall 接口撤回需求评审。仅需求创建人且状态允许时可执行；默认预览。",
  inputSchema: { id: z.number().int().positive(), ...writeGuardSchema },
}, async ({ id, dryRun, confirm }) => safe(() =>
  previewOrRun("recall_story", `/api.php/v1/stories/${id}/recall`, "DELETE", undefined, dryRun, confirm)
));

server.registerTool("zentao_review_story", {
  description: "使用禅道 18.6 官方 review 接口评审需求：pass 通过、reject 拒绝、clarify 待明确、revert 撤销变更。默认预览。",
  inputSchema: {
    id: z.number().int().positive(),
    result: storyReviewResultSchema,
    reviewedDate: dateTimeSchema.optional().describe("不传时由禅道填写当前日期"),
    closedReason: storyClosedReasonSchema.optional().describe("result=reject 时必填"),
    pri: z.number().int().min(1).max(4).optional(),
    estimate: z.number().nonnegative().optional(),
    comment: z.string().optional(),
    ...writeGuardSchema,
  },
}, async ({ id, result, reviewedDate, closedReason, pri, estimate, comment, dryRun, confirm }) => safe(async () => {
  if (result === "reject" && !closedReason) throw new Error("拒绝评审时必须提供 closedReason。");
  if (result !== "reject" && closedReason) throw new Error("closedReason 仅能在 result=reject 时提供。");
  if (result === "reject" && (closedReason === "duplicate" || closedReason === "subdivided")) {
    throw new Error("ZenTao 18.6 官方 REST review 接口不接收 duplicateStory/childStories；拒绝评审请使用其他 closedReason。");
  }
  return previewOrRun(
    "review_story",
    `/api.php/v1/stories/${id}/review`,
    "POST",
    compactBody({ reviewedDate, result, closedReason, pri, estimate, comment }),
    dryRun,
    confirm,
  );
}));

server.registerTool("zentao_close_story", {
  description: "关闭需求。默认预览。",
  inputSchema: {
    id: z.number().int().positive(),
    closedReason: z.enum(["done", "duplicate", "postponed", "willnotdo", "cancel", "bydesign"]).optional().default("done"),
    duplicateStory: z.number().int().positive().optional(), comment: z.string().optional(), ...writeGuardSchema,
  },
}, async ({ id, dryRun, confirm, ...fields }) => safe(() => previewOrRun("close_story", `/api.php/v1/stories/${id}/close`, "POST", compactBody(fields), dryRun, confirm)));

server.registerTool("zentao_delete_story", {
  description: "删除需求。执行前会读取需求并校验标题完全一致且创建人为当前账号，防止误删他人需求；默认预览。",
  inputSchema: { id: z.number().int().positive(), expectedTitle: z.string().min(1), ...writeGuardSchema },
}, async ({ id, expectedTitle, dryRun, confirm }) => safe(async () => {
  if (dryRun !== false || confirm !== true) return { dryRun: true, action: "delete_story", method: "DELETE", endpoint: `/api.php/v1/stories/${id}`, guard: { expectedTitle, mustBeOpenedByCurrentAccount: true } };
  await assertOwnedObject("story", id, expectedTitle);
  return client.request(`/api.php/v1/stories/${id}`, { method: "DELETE" });
}));

server.registerTool("zentao_create_bug", {
  description: "通过禅道 Bug REST API 或官方表单创建 Bug。支持标题、模块、优先级、严重程度、指派、关联、截止日期、实例自定义消耗工时字段、抄送账号和通知邮箱；默认预览。",
  inputSchema: {
    product: z.number().int().positive(), title: z.string().min(1), module: z.number().int().positive(),
    branch: z.number().int().nonnegative().optional().default(0), plan: z.number().int().nonnegative().optional(),
    openedBuild: z.union([z.string().min(1), z.array(z.union([z.string().min(1), z.number().int().positive()])).min(1)]).optional().default("trunk"),
    pri: z.number().int().min(1).max(4).optional().default(3), severity: z.number().int().min(1).max(4).optional().default(3),
    type: bugTypeSchema.optional().default("codeerror"), project: z.number().int().nonnegative().optional(), execution: z.number().int().nonnegative().optional(),
    assignedTo: z.string().optional(), story: z.number().int().nonnegative().optional(), task: z.number().int().nonnegative().optional(),
    steps: z.string().optional(), keywords: z.string().optional(),
    deadline: z.string().date().optional().describe("Bug 截止日期；禅道页面字段为日期，不包含具体时分"),
    consumed: z.number().nonnegative().optional().describe("Bug 消耗工时，单位小时；仅在禅道实例的 Bug 表单提供 consumed 字段时生效"),
    estimate: z.number().nonnegative().optional().describe("兼容别名；会映射为表单字段 consumed，是否可用取决于实例配置"),
    mailto: z.array(z.string().min(1)).max(100).optional().describe("抄送账号列表"),
    notifyEmail: z.string().optional().describe("通知邮箱"),
    feedbackBy: z.string().optional().describe("反馈者"),
    os: z.array(z.string().min(1)).max(50).optional().describe("操作系统"),
    browser: z.array(z.string().min(1)).max(50).optional().describe("浏览器"),
    case: z.number().int().nonnegative().optional().describe("关联测试用例 ID"),
    testtask: z.number().int().nonnegative().optional().describe("关联测试单 ID"),
    ...writeGuardSchema,
  },
}, async ({ product, dryRun, confirm, ...fields }) => safe(async () => {
  if (fields.consumed !== undefined && fields.estimate !== undefined) throw new Error("consumed 与 estimate 只能传一个。");
  const consumed = fields.consumed ?? fields.estimate;
  const body = compactBody({ ...fields, product, consumed });
  delete body.estimate;
  if (typeof body.steps === "string") body.steps = formatBugSteps(body.steps);
  // The 18.6 Bug form names the impact-build control openedBuild[]. A scalar
  // default such as "trunk" is silently ignored by some deployments.
  if (usesBugFormController(fields) && typeof body.openedBuild === "string") body.openedBuild = [body.openedBuild];
  if (body.branch === 0) delete body.branch;
  const needsFormController = usesBugFormController(fields);
  if (dryRun !== false || confirm !== true) {
    return {
      dryRun: true,
      action: "create_bug",
      method: needsFormController ? "POST_FORM" : "POST",
      endpoint: needsFormController ? bugCreateFormEndpoint(product, fields.branch) : `/api.php/v1/products/${product}/bugs`,
      body,
      message: "预览模式：确认内容后设置 dryRun=false 且 confirm=true 执行。",
    };
  }
  if (needsFormController) {
    const result = await client.formRequest(bugCreateFormEndpoint(product, fields.branch), body);
    const createdId = payloadId(result);
    const created = createdId ? await getBugById(createdId) : await findCreatedBug(product, String(fields.title));
    if (!created) {
      if (isObject(result) && result._emptyResponse === true) {
        throw new Error("禅道 Bug 表单返回 HTTP 200 空响应，且未通过查询确认已落库；为避免重复创建，MCP 未自动重试。请检查禅道记录或稍后使用 Bug 列表确认后再操作。");
      }
      throw new Error("禅道 Bug 表单返回成功响应，但无法读取新 Bug 详情核对字段；MCP 不报告为成功，请在禅道中确认后再操作。");
    }
    const requestedFields = compactBody({ ...fields, product, consumed });
    delete requestedFields.estimate;
    assertBugFields(created, requestedFields);
    return {
      response: result,
      verified: true,
      warning: isObject(result) && result._emptyResponse === true
        ? "禅道 Bug 表单返回 HTTP 200 空响应，但已通过详情核对确认 Bug 已落库；MCP 未重试，避免重复创建。"
        : undefined,
      bug: created,
    };
  }
  return client.request(`/api.php/v1/products/${product}/bugs`, { method: "POST", body });
}));

server.registerTool("zentao_update_bug", {
  description: "修改 Bug 字段。默认预览。",
  inputSchema: {
    id: z.number().int().positive(), title: z.string().min(1).optional(), product: z.number().int().positive().optional(),
    project: z.number().int().nonnegative().optional(), execution: z.number().int().nonnegative().optional(), module: z.number().int().positive().optional(),
    openedBuild: z.union([z.string().min(1), z.array(z.union([z.string().min(1), z.number().int().positive()])).min(1)]).optional(),
    assignedTo: z.string().optional(), pri: z.number().int().min(1).max(4).optional(), severity: z.number().int().min(1).max(4).optional(),
    type: bugTypeSchema.optional(), story: z.number().int().nonnegative().optional(), task: z.number().int().nonnegative().optional(),
    steps: z.string().optional(), keywords: z.string().optional(),
    deadline: z.string().date().optional().describe("Bug 截止日期；禅道页面字段为日期，不包含具体时分"),
    consumed: z.number().nonnegative().optional().describe("Bug 消耗工时，单位小时；仅在禅道实例的 Bug 表单提供 consumed 字段时生效"),
    estimate: z.number().nonnegative().optional().describe("兼容别名；会映射为表单字段 consumed，是否可用取决于实例配置"),
    mailto: z.array(z.string().min(1)).max(100).optional().describe("抄送账号列表"),
    notifyEmail: z.string().optional().describe("通知邮箱"),
    branch: z.number().int().nonnegative().optional(), plan: z.number().int().nonnegative().optional(),
    feedbackBy: z.string().optional().describe("反馈者"),
    os: z.array(z.string().min(1)).max(50).optional().describe("操作系统"),
    browser: z.array(z.string().min(1)).max(50).optional().describe("浏览器"),
    case: z.number().int().nonnegative().optional().describe("关联测试用例 ID"),
    testtask: z.number().int().nonnegative().optional().describe("关联测试单 ID"),
    ...writeGuardSchema,
  },
}, async ({ id, dryRun, confirm, ...fields }) => safe(async () => {
  if (fields.consumed !== undefined && fields.estimate !== undefined) throw new Error("consumed 与 estimate 只能传一个。");
  const consumed = fields.consumed ?? fields.estimate;
  const body = compactBody({ ...fields, consumed });
  delete body.estimate;
  if (typeof body.steps === "string") body.steps = formatBugSteps(body.steps);
  if (!Object.keys(body).length) throw new Error("至少提供一个需要修改的 Bug 字段。");
  const needsFormController = usesBugFormController(fields);
  if (dryRun !== false || confirm !== true) {
    return {
      dryRun: true,
      action: "update_bug",
      method: needsFormController ? "POST_FORM" : "PUT",
      endpoint: needsFormController ? bugEditFormEndpoint(id) : `/api.php/v1/bugs/${id}`,
      body,
      message: "预览模式：确认内容后设置 dryRun=false 且 confirm=true 执行。",
    };
  }
  if (!needsFormController) return client.request(`/api.php/v1/bugs/${id}`, { method: "PUT", body });

  const current = entityFromPayload(await client.request(`/api.php/v1/bugs/${id}`), "bug");
  const merged = compactBody({
    title: fields.title ?? currentField(current, "title"),
    product: fields.product ?? scalarValue(currentField(current, "product")),
    project: fields.project ?? scalarValue(currentField(current, "project")),
    execution: fields.execution ?? scalarValue(currentField(current, "execution")),
    module: fields.module ?? scalarValue(currentField(current, "module")),
    openedBuild: fields.openedBuild ?? listValues(currentField(current, "openedBuild")),
    assignedTo: fields.assignedTo ?? accountOf(currentField(current, "assignedTo")),
    pri: fields.pri ?? scalarValue(currentField(current, "pri")),
    severity: fields.severity ?? scalarValue(currentField(current, "severity")),
    type: fields.type ?? currentField(current, "type"),
    story: fields.story ?? scalarValue(currentField(current, "story")),
    task: fields.task ?? scalarValue(currentField(current, "task")),
    steps: fields.steps !== undefined ? formatBugSteps(fields.steps) : currentField(current, "steps"),
    keywords: fields.keywords ?? currentField(current, "keywords"),
    deadline: fields.deadline ?? currentField(current, "deadline"),
    consumed: consumed ?? scalarValue(currentField(current, "consumed")),
    mailto: fields.mailto ?? listValues(currentField(current, "mailto")),
    notifyEmail: fields.notifyEmail ?? currentField(current, "notifyEmail"),
    branch: fields.branch ?? scalarValue(currentField(current, "branch")),
    plan: fields.plan ?? scalarValue(currentField(current, "plan")),
    feedbackBy: fields.feedbackBy ?? currentField(current, "feedbackBy"),
    os: fields.os ?? listValues(currentField(current, "os")),
    browser: fields.browser ?? listValues(currentField(current, "browser")),
    case: fields.case ?? scalarValue(currentField(current, "case")),
    testtask: fields.testtask ?? scalarValue(currentField(current, "testtask")),
  });
  const result = await client.formRequest(bugEditFormEndpoint(id), merged);
  const currentAfterRequest = await getBugById(id);
  const requestedFields = { ...fields, consumed } as Record<string, unknown>;
  delete requestedFields.estimate;
  assertBugFields(currentAfterRequest, requestedFields);
  return {
    response: result,
    verified: true,
    warning: isObject(result) && result._emptyResponse === true
      ? "禅道 Bug 表单返回 HTTP 200 空响应，但已通过详情核对确认修改已生效。"
      : undefined,
    bug: currentAfterRequest,
  };
}));

server.registerTool("zentao_update_bug_links", {
  description: "独立关联或解除 Bug 与需求/任务的关系。linkStory/linkTask 设置关联，unlinkStory/unlinkTask 清除关联；使用禅道 18.6 官方 Bug PUT 接口。默认预览。",
  inputSchema: {
    id: z.number().int().positive().describe("Bug ID"),
    linkStory: z.number().int().positive().optional().describe("要关联的需求 ID"),
    unlinkStory: z.boolean().optional().default(false),
    linkTask: z.number().int().positive().optional().describe("要关联的任务 ID"),
    unlinkTask: z.boolean().optional().default(false),
    ...writeGuardSchema,
  },
}, async ({ id, linkStory, unlinkStory, linkTask, unlinkTask, dryRun, confirm }) => safe(async () => {
  if (linkStory !== undefined && unlinkStory) throw new Error("linkStory 与 unlinkStory 不能同时提供。");
  if (linkTask !== undefined && unlinkTask) throw new Error("linkTask 与 unlinkTask 不能同时提供。");
  if (linkStory === undefined && !unlinkStory && linkTask === undefined && !unlinkTask) {
    throw new Error("至少提供一个关联或解除关联操作。");
  }
  const body = compactBody({
    story: unlinkStory ? 0 : linkStory,
    task: unlinkTask ? 0 : linkTask,
  });
  return previewOrRun("update_bug_links", `/api.php/v1/bugs/${id}`, "PUT", body, dryRun, confirm);
}));

server.registerTool("zentao_resolve_bug", {
  description: "解决 Bug。默认使用 resolution=fixed、resolvedBuild=trunk；默认预览。",
  inputSchema: {
    id: z.number().int().positive(), resolution: bugResolutionSchema.optional().default("fixed"),
    resolvedBuild: z.union([z.string().min(1), z.number().int().positive()]).optional().default("trunk"),
    duplicateBug: z.number().int().positive().optional(), assignedTo: z.string().optional(), resolvedDate: dateTimeSchema.optional(),
    comment: z.string().optional(), ...writeGuardSchema,
  },
}, async ({ id, dryRun, confirm, ...fields }) => safe(() => previewOrRun("resolve_bug", `/api.php/v1/bugs/${id}/resolve`, "POST", compactBody(fields), dryRun, confirm)));

server.registerTool("zentao_close_bug", {
  description: "关闭已解决的 Bug。默认预览。",
  inputSchema: { id: z.number().int().positive(), comment: z.string().optional(), ...writeGuardSchema },
}, async ({ id, dryRun, confirm, comment }) => safe(() => previewOrRun("close_bug", `/api.php/v1/bugs/${id}/close`, "POST", compactBody({ comment }), dryRun, confirm)));

server.registerTool("zentao_delete_bug", {
  description: "删除 Bug。执行前会读取 Bug 并校验标题完全一致且创建人为当前账号，防止误删他人 Bug；默认预览。",
  inputSchema: { id: z.number().int().positive(), expectedTitle: z.string().min(1), ...writeGuardSchema },
}, async ({ id, expectedTitle, dryRun, confirm }) => safe(async () => {
  if (dryRun !== false || confirm !== true) return { dryRun: true, action: "delete_bug", method: "DELETE", endpoint: `/api.php/v1/bugs/${id}`, guard: { expectedTitle, mustBeOpenedByCurrentAccount: true } };
  await assertOwnedObject("bug", id, expectedTitle);
  return client.request(`/api.php/v1/bugs/${id}`, { method: "DELETE" });
}));

server.registerTool("zentao_create_task", {
  description: "按禅道 18.6 创建任务表单创建任务。支持任务类型、所属模块、所有模块标记、指派给、多人任务及团队工时、相关需求、任务名称、优先级、预计工时、任务描述、附件、预计开始日期、截止日期和抄送；默认预览。任务类型支持官方 key design/devel/request/test/study/discuss/ui/affair/misc 或中文值规划/设计/开发/需求/测试/研究/讨论/界面/事务/其他。附件传本机绝对路径，只在 confirm=true 且 dryRun=false 时读取并上传。",
  inputSchema: {
    execution: z.number().int().positive(),
    name: z.string().min(1),
    assignedTo: z.string().min(1).optional().describe("不传时使用当前配置账号"),
    type: taskTypeSchema.optional().default("devel"),
    estStarted: z.string().date().optional().describe("不传时默认今天"),
    deadline: z.string().date().optional().describe("不传时默认预计开始日期的下一天；必须晚于 estStarted"),
    module: z.number().int().nonnegative().optional().default(0),
    story: z.number().int().nonnegative().optional().default(0),
    pri: z.number().int().min(1).max(4).optional().default(3),
    estimate: z.number().nonnegative().optional().default(1),
    desc: z.string().optional(),
    mailto: z.array(z.string().min(1)).max(100).optional().describe("抄送账号列表"),
    allModule: z.boolean().optional().default(false).describe("是否允许从所有模块中选择；仅对应页面筛选，不写入任务记录"),
    multiple: z.boolean().optional().default(false).describe("是否创建多人任务"),
    mode: taskModeSchema.describe("多人任务模式：linear=多人串行，multi=多人并行"),
    team: z.array(z.string().min(1)).min(2).max(100).optional().describe("多人任务成员账号，至少 2 人"),
    teamEstimate: z.array(z.number().positive()).max(100).optional().describe("多人任务各成员预计工时，与 team 一一对应"),
    attachments: z.array(z.object({
      path: z.string().min(1).describe("要上传的本机文件绝对路径"),
      label: z.string().optional().describe("附件显示标题；不传时由禅道使用文件名"),
    })).max(20).optional(),
    after: taskAfterSchema.describe("创建后动作；API 创建不会改变任务数据，仅用于记录调用意图"),
    ...writeGuardSchema,
  },
}, async (args) => safe(async () => {
  const { execution, dryRun, confirm, ...fields } = args;
  const today = new Date().toLocaleDateString("en-CA");
  const estStarted = fields.estStarted ?? today;
  const deadline = fields.deadline ?? localDateAfterDaysFrom(estStarted, 1);
  const team = fields.team?.filter(Boolean);
  const multiple = fields.multiple === true;
  if (multiple) {
    if (!team || team.length < 2) throw new Error("多人任务至少需要 2 名 team 成员。");
    if (new Set(team).size !== team.length) throw new Error("多人任务的 team 成员不能重复。");
    if (!fields.teamEstimate || fields.teamEstimate.length !== team.length) {
      throw new Error("teamEstimate 必须与 team 长度一致，并为每名成员提供预计工时。");
    }
  } else if (team || fields.teamEstimate) {
    throw new Error("team 和 teamEstimate 只能在 multiple=true 时使用。");
  }

  const estimate = multiple
    ? fields.teamEstimate!.reduce((total, hours) => total + hours, 0)
    : fields.estimate;
  const assignedTo = fields.assignedTo ?? team?.[0] ?? account;
  const body: Record<string, unknown> = compactBody({
    name: fields.name,
    assignedTo,
    type: fields.type,
    estStarted,
    deadline,
    module: fields.module,
    story: fields.story,
    pri: fields.pri,
    estimate,
    desc: fields.desc,
    mailto: fields.mailto,
    multiple: multiple ? 1 : undefined,
    mode: multiple ? fields.mode : undefined,
    team: multiple ? team : undefined,
    teamEstimate: multiple ? fields.teamEstimate : undefined,
  });
  if (!body.assignedTo) throw new Error("缺少 assignedTo，且未配置 ZENTAO_ACCOUNT。");
  if (String(body.deadline) <= String(body.estStarted)) throw new Error("deadline 必须晚于 estStarted，禅道 18.6 不接受同一天或更早的截止日期。");
  const attachmentPreview = fields.attachments?.map(({ path, label }) => ({ path, label }));
  if (dryRun !== false || confirm !== true) {
    return {
      dryRun: true,
      action: "create_task",
      method: fields.attachments?.length ? "POST_MULTIPART" : "POST",
      endpoint: `/api.php/v1/executions/${execution}/tasks`,
      body,
      attachments: attachmentPreview,
      uiOptions: { allModule: fields.allModule, after: fields.after },
      message: "预览模式：确认内容后设置 dryRun=false 且 confirm=true 执行。",
    };
  }
  if (fields.attachments?.length) {
    const formBody = compactBody({ ...body, execution, status: "wait" });
    const assigned = formBody.assignedTo;
    formBody.assignedTo = Array.isArray(assigned) ? assigned : [assigned];
    return client.formRequest(`/api.php/v1/executions/${execution}/tasks`, formBody, fields.attachments);
  }
  return client.request(`/api.php/v1/executions/${execution}/tasks`, { method: "POST", body });
}));

const transport = new StdioServerTransport();
await server.connect(transport);
