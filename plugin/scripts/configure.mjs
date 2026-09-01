#!/usr/bin/env node
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { stdin, stdout } from "node:process";

const defaultConfigPath = resolve(homedir(), ".config", "zentao-v1", "credentials.json");

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function question(prompt, { hidden = false } = {}) {
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    throw new Error("Interactive setup requires a terminal.");
  }
  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((resolveValue, reject) => {
    let value = "";
    const cleanup = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\n");
    };
    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === "\u0003") {
          cleanup();
          reject(new Error("Setup cancelled."));
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          resolveValue(value);
          return;
        }
        if (character === "\u007f" || character === "\b") {
          if (value) {
            value = value.slice(0, -1);
            stdout.write("\b \b");
          }
          continue;
        }
        if (character >= " ") {
          value += character;
          stdout.write(hidden ? "*" : character);
        }
      }
    };
    stdin.on("data", onData);
  });
}

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : {}; }
  catch { throw new Error(`ZenTao returned non-JSON data (HTTP ${response.status}).`); }
  if (!response.ok) throw new Error(`ZenTao HTTP ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

async function main() {
  let baseUrl = arg("--url") ?? await question("ZenTao base URL: ");
    baseUrl = baseUrl.trim().replace(/\/+$/, "");
    let parsedUrl;
    try { parsedUrl = new URL(baseUrl); }
    catch { throw new Error("Enter a complete ZenTao http/https URL."); }
    if (!["http:", "https:"].includes(parsedUrl.protocol)) throw new Error("ZenTao URL must use http or https.");

    const requestedMode = (arg("--auth") ?? await question("Authentication method [password/token] (password): ")).trim().toLowerCase();
    const mode = requestedMode || "password";
    if (!["password", "token"].includes(mode)) throw new Error("Authentication method must be password or token.");

    let account = (arg("--account") ?? "").trim();
    let token;
    let password;
    let savePassword = false;
    if (mode === "token") {
      token = process.env.ZENTAO_SETUP_TOKEN ?? await question("ZenTao API token (hidden): ", { hidden: true });
      if (!token) throw new Error("Token is required.");
    } else {
      if (!account) account = (await question("ZenTao account: ")).trim();
      if (!account) throw new Error("Account is required.");
      password = process.env.ZENTAO_SETUP_PASSWORD ?? await question("ZenTao password (hidden): ", { hidden: true });
      if (!password) throw new Error("Password is required.");
      const login = await jsonRequest(`${baseUrl}/api.php/v1/tokens`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ account, password }),
      });
      if (typeof login.token !== "string" || !login.token) throw new Error("ZenTao did not return an API token.");
      token = login.token;
      const answer = (await question("Save password for automatic token refresh? [y/N]: ")).trim().toLowerCase();
      savePassword = answer === "y" || answer === "yes";
    }

    const profile = await jsonRequest(`${baseUrl}/api.php/v1/user`, { headers: { Token: token, Accept: "application/json" } });
    const profileAccount = typeof profile?.profile?.account === "string" ? profile.profile.account : account;
    const realname = typeof profile?.profile?.realname === "string" ? profile.profile.realname : profileAccount;
    const configPath = resolve(arg("--config") ?? defaultConfigPath);
    const configDir = dirname(configPath);
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    const tempPath = `${configPath}.${process.pid}.tmp`;
    const credentials = { url: baseUrl, account: profileAccount, token, ...(savePassword ? { password } : {}) };
    await writeFile(tempPath, `${JSON.stringify(credentials, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(tempPath, configPath);
    await chmod(configPath, 0o600).catch(() => undefined);

    if (process.platform === "win32" && process.env.USERNAME) {
      spawnSync("icacls", [configPath, "/inheritance:r", "/grant:r", `${process.env.USERNAME}:(F)`], { stdio: "ignore" });
    }

    password = undefined;
    token = undefined;
    stdout.write(`Configured successfully for ${realname || "the current user"}.\n`);
    stdout.write(`Credentials saved to ${configPath}. Fully restart Claude Code.\n`);
    if (!savePassword && mode === "password") stdout.write("The password was not saved. Re-run setup if the token expires.\n");
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
