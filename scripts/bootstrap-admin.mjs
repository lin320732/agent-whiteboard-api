#!/usr/bin/env node
// One-time bootstrap. Reads the key locally; writes the resulting credentials
// to a 0600 file, never to stdout, Git or shell command arguments.
import { readFileSync, writeFileSync, openSync, closeSync, unlinkSync, fsyncSync } from "node:fs";

const url = "https://agent-whiteboard-api.penzibdc.workers.dev";
const key = readFileSync(".bootstrap-key", "utf8").trim();
if (!/^[a-f0-9]{64}$/.test(key)) throw Error(".bootstrap-key must contain a 32-byte random hex value");
const fd = openSync(".admin-login.json", "wx", 0o600);
let created = false;
try {
  const response = await fetch(`${url}/api/admin/bootstrap`, {
    method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: "{}",
  });
  const data = await response.json();
  if (!response.ok || !data.ok || !data.password) throw Error(`Bootstrap failed: HTTP ${response.status} ${data.error || ""}`);
  created = true;
  writeFileSync(fd, JSON.stringify({ username: data.username, password: data.password, muse_token: data.muse_token }, null, 2) + "\n");
  fsyncSync(fd);
  console.log("Admin account created; read .admin-login.json locally and store it in your password manager. No secret was printed.");
} catch (error) {
  if (!created) unlinkSync(".admin-login.json");
  else console.error("Bootstrap succeeded but saving credentials failed; inspect .admin-login.json before retrying.");
  throw error;
} finally { closeSync(fd); }
