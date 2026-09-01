import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = resolve(root, process.argv[2] ?? "plugin/server.js");
const tempDir = await mkdtemp(join(tmpdir(), "zentao-v1-smoke-"));
const env = { ...process.env, ZENTAO_CONFIG_PATH: join(tempDir, "missing.json") };
for (const name of ["ZENTAO_URL", "ZENTAO_TOKEN", "ZENTAO_ACCOUNT", "ZENTAO_PASSWORD"]) delete env[name];

const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath], env, stderr: "pipe" });
const client = new Client({ name: "zentao-v1-plugin-smoke", version: "1.0.0" });
try {
  await client.connect(transport);
  const tools = await client.listTools();
  const requiredTools = [
    "zentao_list_my_tasks", "zentao_list_my_bugs", "zentao_create_story", "zentao_edit_story",
    "zentao_assign_story", "zentao_recall_story", "zentao_review_story", "zentao_update_task_links",
    "zentao_create_task", "zentao_record_task_effort", "zentao_list_task_efforts",
    "zentao_update_task_effort", "zentao_delete_task_effort", "zentao_create_bug", "zentao_update_bug_links",
  ];
  for (const name of requiredTools) if (!tools.tools.some((tool) => tool.name === name)) throw new Error(`${name} is missing.`);
  const status = await client.callTool({ name: "zentao_setup_status", arguments: {} });
  const payload = JSON.parse(status.content?.[0]?.text ?? "{}");
  if (payload.setupRequired !== true) throw new Error("Bundled server did not report setupRequired=true.");
  process.stdout.write(`Bundled plugin smoke test passed (${tools.tools.length} tools).\n`);
} finally {
  await client.close().catch(() => undefined);
  await rm(tempDir, { recursive: true, force: true });
}
