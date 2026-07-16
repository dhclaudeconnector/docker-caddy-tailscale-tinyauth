#!/usr/bin/env node
// scripts/runners/keep-alive.mjs
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "jsonc-parser";
import { detectDocker, dockerCmd } from "./_docker.mjs";
import { parseEnv } from "../lib/env-utils.mjs";
import { redactSecrets } from "../lib/redact-utils.mjs";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const SILENT = args.includes("--silent");
const log = (...a) => { if (!SILENT) console.log(...a); };

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const CONFIG_FILE = resolve(__dirname, "keep-alive-config.jsonc");
const env = { ...parseEnv(resolve(ROOT, ".env")), ...process.env };

process.chdir(ROOT);

function loadConfig() {
  const defaults = { default_keep_minutes: 5, default_interval_seconds: 30, services: [], curl_timeout_seconds: 12 };
  if (!existsSync(CONFIG_FILE)) return defaults;
  return { ...defaults, ...parse(readFileSync(CONFIG_FILE, "utf8")) };
}

function num(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sh(cmd) {
  if (DRY_RUN) return "";
  try {
    return execSync(cmd, { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] }).toString().trim();
  } catch (e) {
    return (e.stdout || e.stderr || "").toString().trim();
  }
}

function expand(value) {
  return String(value || "").replace(/\$\{([A-Z_][A-Z0-9_]*)(:-([^}]*))?\}/g, (_, key, _fallbackExpr, fallback) => env[key] || fallback || "");
}

function splitUrls(value) {
  return expand(value).split(",").map((url) => url.trim()).filter(Boolean);
}

function serviceUrls(config) {
  const urls = [];
  for (const service of config.services || []) {
    const raw = service.env?.map((key) => env[key]).find(Boolean) || service.fallback || "";
    for (const url of splitUrls(raw)) urls.push({ service: service.name, url });
  }
  return urls;
}

function curlUrl(item, timeout) {
  const cmd = `curl -k -sS -o /dev/null -w "%{http_code}" --max-time ${timeout} -I "${item.url}"`;
  if (DRY_RUN) return log(`[DRY RUN] ${cmd}`);
  const code = sh(cmd) || "ERR";
  log(`[url] ${item.service} ${item.url} ${code}`);
}

function runningContainers() {
  const rows = sh(dockerCmd('ps --format "{{.ID}}\\t{{.Names}}"')).split(/\r?\n/).filter(Boolean);
  return rows.map((row) => {
    const [id, name] = row.split("\t");
    return { id, name };
  });
}

function showLogs(since) {
  const containers = runningContainers();
  log("[containers]");
  log(containers.map((c) => `${c.id} ${c.name}`).join("\n") || "(none)");
  for (const c of containers) {
    log(`===== ${c.name} logs since ${since} =====`);
    const out = sh(dockerCmd(`logs --timestamps --since "${since}" ${c.id}`));
    log(redactSecrets(out || "(no new logs)"));
  }
}

const config = loadConfig();
const keepSeconds = Math.round(num(env.KEEP_SECONDS, num(env.KEEP_MIN, num(env.KEEP_ALIVE_MINUTES, config.default_keep_minutes)) * 60));
const intervalSeconds = Math.round(num(env.KEEP_INTERVAL_SECONDS, num(env.INTERVAL_SECONDS, num(env.INTERVAL_MIN, config.default_interval_seconds / 60) * 60)));
const publicUrl = existsSync(resolve(ROOT, "public-url.txt")) ? readFileSync(resolve(ROOT, "public-url.txt"), "utf8").trim() : "unknown";

if (!detectDocker().available) {
  console.error("ERROR: Docker not found.");
  process.exit(1);
}

log(`Keeping stack alive for ${keepSeconds}s, heartbeat every ${intervalSeconds}s. URL: ${publicUrl}`);

let elapsed = 0;
let since = new Date().toISOString();
while (elapsed < keepSeconds) {
  const sleepSeconds = Math.min(intervalSeconds, keepSeconds - elapsed);
  if (!DRY_RUN) execSync(`sleep ${sleepSeconds}`, { stdio: "ignore" });
  elapsed += sleepSeconds;
  log(`[heartbeat] ${new Date().toISOString()} ${elapsed}/${keepSeconds}s`);
  const ps = sh(dockerCmd("compose ps"));
  if (ps) log(ps);
  for (const item of serviceUrls(config)) curlUrl(item, config.curl_timeout_seconds);
  showLogs(since);
  since = new Date().toISOString();
  if (DRY_RUN) break;
}
