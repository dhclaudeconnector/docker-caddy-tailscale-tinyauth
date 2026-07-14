#!/usr/bin/env node
// tailscale/scripts/status.mjs
// Show Tailscale node status inside the stack container.
//
// Flags:
//   --dry-run   Show what would be done
//   --silent    Suppress output
import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { detectDocker, dockerCmd } from "../../scripts/runners/_docker.mjs";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const SILENT = args.includes("--silent");
const log = (...a) => { if (!SILENT) console.log(...a); };

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
process.chdir(ROOT);

const docker = detectDocker();
if (!docker.available) { console.error("ERROR: Docker not found."); process.exit(1); }

function sh(cmd) {
  try { return execSync(cmd, { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] }).toString().trim(); }
  catch { return ""; }
}

if (DRY_RUN) { log("[DRY RUN] Would show tailscale status"); process.exit(0); }

const running = sh(dockerCmd("compose ps --status running --services"));
if (!running.split("\n").includes("tailscale")) {
  console.error("ERROR: tailscale is not running. Start with:");
  console.error("  docker compose --profile tailscale up -d");
  process.exit(1);
}

log(sh(dockerCmd("compose exec -T tailscale tailscale status")));
