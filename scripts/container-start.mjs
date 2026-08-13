#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnvironment } from "../dist/src/installer.js";

const projectDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const environmentFile = process.env.FEISHU_BRIDGE_ENV ?? join(homedir(), ".config", "feishu-codex-bridge", "env");
const values = parseEnvironment(await readFile(environmentFile, "utf8"));
const childEnvironment = { ...process.env, ...values, NODE_ENV: "production" };
const entrypoint = join(projectDir, "dist", "src", "index.js");
const restartDelayMs = 5_000;

let child;
let stopping = false;
let wakeRestart;

function forward(signal) {
  if (stopping) return;
  stopping = true;
  child?.kill(signal);
  wakeRestart?.();
}

process.on("SIGINT", () => forward("SIGINT"));
process.on("SIGTERM", () => forward("SIGTERM"));

while (!stopping) {
  child = spawn(process.execPath, [entrypoint], {
    cwd: projectDir,
    env: childEnvironment,
    stdio: "inherit",
  });
  const result = await new Promise((resolveExit) => {
    child.once("error", (error) => resolveExit({ error }));
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  child = undefined;
  if (stopping) break;
  console.error(`Bridge exited (${result.error ?? result.signal ?? `code ${result.code}`}); restarting in ${restartDelayMs / 1000}s.`);
  await new Promise((resolveDelay) => {
    wakeRestart = resolveDelay;
    setTimeout(resolveDelay, restartDelayMs);
  });
  wakeRestart = undefined;
}
