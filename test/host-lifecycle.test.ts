import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AccountDescriptor, ProviderOptionsState } from "../src/types";
import { getSharedMcpServer } from "../src/mcp/http-server";
import { GlobalScheduler } from "../src/runtime/scheduler";
import { buildEffectiveSystemText } from "../src/runtime/worker";
import { SessionCoordinator } from "../src/sessions/coordinator";
import { outgoingSystemDigest } from "../src/sessions/ledger";
import { spawnFakeAcp } from "./fixtures/helpers";

const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "agy-host-lifecycle-"));
const REPO_ROOT = path.resolve(import.meta.dir, "..");
const SCHEDULER_PATH = path.join(REPO_ROOT, "src", "runtime", "scheduler.ts");

const isolatedEnv = {
  HOME: path.join(TEMP_ROOT, "home"),
  AGY_ACP_DATA_DIR: path.join(TEMP_ROOT, "data"),
  ANTIGRAVITY_MAGPIE_DATA_DIR: path.join(TEMP_ROOT, "magpie"),
  XDG_CONFIG_HOME: path.join(TEMP_ROOT, "config"),
  XDG_CACHE_HOME: path.join(TEMP_ROOT, "cache"),
};

let origEnv: Record<string, string | undefined> = {};

const testAccount: AccountDescriptor = {
  slotKey: "agy#lifecycle",
  accountRef: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  mode: "host",
  label: "Lifecycle",
  isolatedHomeDir: null,
};

const providerSaidAs = "ZigguratProviderToken=provider-rewrite-xyz";
const turnSaidAs = "ZigguratTurnToken=turn-rewrite-xyz";
const systemText =
  "Keep ZigguratProviderToken and ZigguratTurnToken in the instructions.";

function providerState(cloakSaidAs: string): ProviderOptionsState {
  return {
    quotaRouting: false,
    cloakPrompts: true,
    minimalAgent: false,
    exposeThinking: false,
    cloakSaidAs,
    accountFailover: false,
  };
}

beforeAll(() => {
  origEnv = {
    HOME: process.env.HOME,
    AGY_ACP_DATA_DIR: process.env.AGY_ACP_DATA_DIR,
    ANTIGRAVITY_MAGPIE_DATA_DIR: process.env.ANTIGRAVITY_MAGPIE_DATA_DIR,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
  };
  for (const [key, value] of Object.entries(isolatedEnv)) {
    process.env[key] = value;
    fs.mkdirSync(value, { recursive: true });
  }
});

afterAll(() => {
  for (const [key, value] of Object.entries(origEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
});

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function writeChildScript(): string {
  const childPath = path.join(TEMP_ROOT, "signal-child.mjs");
  fs.writeFileSync(
    childPath,
    `
import { spawn } from "node:child_process";
import { GlobalScheduler } from ${JSON.stringify(SCHEDULER_PATH)};

const mode = process.argv[2];
const signalName = process.argv[3] || "SIGTERM";

const workerChild = spawn("sleep", ["30"], { stdio: "ignore" });
if (!workerChild.pid) throw new Error("failed to spawn sleep");

if (mode === "host-once-before" || mode === "host-once-stay") {
  process.once(signalName, () => {
    process.stderr.write("HOST_ONCE_START\\n");
    if (mode === "host-once-stay") return;
    setTimeout(() => {
      process.stderr.write("HOST_CLEANUP_COMPLETE\\n");
      process.exit(42);
    }, 80);
  });
}

const sched = new GlobalScheduler({
  maxGlobalWorkers: 1,
  maxPerAccountWorkers: 1,
  idleTimeoutMs: 60_000,
  reaperIntervalMs: 60_000,
  waitTimeoutMs: 0,
  installSignalHandlers: mode === "standalone",
});

const worker = {
  account: {
    slotKey: "agy#signal",
    accountRef: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    mode: "host",
    label: "signal",
    isolatedHomeDir: null,
  },
  state: "IDLE",
  pinned: false,
  lastActivityAt: Date.now(),
  closeSync() {
    process.stderr.write("CLOSE_SYNC\\n");
    try { workerChild.kill("SIGKILL"); } catch {}
    this.state = "CLOSED";
  },
  async close() { this.closeSync(); },
};

if (mode !== "after-destroy") {
  sched.registerWorker(worker);
} else {
  try { workerChild.kill("SIGKILL"); } catch {}
  sched.destroy();
}

if (mode === "embedded" || mode === "after-destroy" || mode === "standalone") {
  process.on(signalName, () => {
    process.stderr.write("HOST_START\\n");
    setTimeout(() => {
      process.stderr.write("HOST_CLEANUP_COMPLETE\\n");
      process.exit(42);
    }, 80);
  });
}

process.stderr.write(
  "CHILD_READY mode=" + mode +
  " pid=" + process.pid +
  " workerPid=" + workerChild.pid + "\\n",
);
await new Promise(() => {});
`,
  );
  return childPath;
}

function runSignalChild(
  childPath: string,
  mode: string,
  signal: NodeJS.Signals = "SIGTERM",
  options?: { secondSignal?: NodeJS.Signals; secondAfter?: string },
): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  workerPid: number | null;
  workerAlive: boolean;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", [childPath, mode, signal], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        ...isolatedEnv,
        BROWSER: "/usr/bin/false",
        AGY_CLI_DISABLE_AUTO_UPDATE: "true",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    let sent = false;
    let secondSent = false;
    let workerPid: number | null = null;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`timed out waiting for ${mode}: ${stderr}`));
    }, 5_000);
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
      const match = stderr.match(/workerPid=(\d+)/);
      if (match) workerPid = Number(match[1]);
      if (!sent && stderr.includes("CHILD_READY")) {
        sent = true;
        child.kill(signal);
      }
      if (
        options?.secondAfter &&
        !secondSent &&
        stderr.includes(options.secondAfter)
      ) {
        secondSent = true;
        child.kill(options.secondSignal ?? signal);
      }
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code, diedSignal) => {
      clearTimeout(timer);
      resolve({
        code,
        signal: diedSignal,
        stderr,
        workerPid,
        workerAlive: workerPid != null && isPidAlive(workerPid),
      });
    });
  });
}

describe("host process ownership", () => {
  test("embedded scheduler lets the host finish asynchronous SIGTERM cleanup and reaps workers", async () => {
    const childPath = writeChildScript();
    const result = await runSignalChild(childPath, "embedded");
    expect(result.stderr).toContain("HOST_START");
    expect(result.stderr).toContain("HOST_CLEANUP_COMPLETE");
    expect(result.stderr).toContain("CLOSE_SYNC");
    expect(result.code).toBe(42);
    expect(result.signal).toBeNull();
    expect(result.workerAlive).toBe(false);
  });

  test("destroying the last scheduler restores host SIGTERM ownership", async () => {
    const childPath = writeChildScript();
    const result = await runSignalChild(childPath, "after-destroy");
    expect(result.stderr).toContain("HOST_START");
    expect(result.stderr).toContain("HOST_CLEANUP_COMPLETE");
    expect(result.code).toBe(42);
    expect(result.signal).toBeNull();
  });

  test("standalone ownership still terminates the process after closing workers", async () => {
    const childPath = writeChildScript();
    const result = await runSignalChild(childPath, "standalone");
    expect(result.stderr).toContain("CLOSE_SYNC");
    expect(result.stderr).not.toContain("HOST_CLEANUP_COMPLETE");
    expect(result.code).toBe(143);
    expect(result.signal).toBeNull();
    expect(result.workerAlive).toBe(false);
  });

  test("SIGTERM with no host listener reaps the worker child and restores default termination", async () => {
    const childPath = writeChildScript();
    const result = await runSignalChild(childPath, "default", "SIGTERM");
    expect(result.stderr).toContain("CLOSE_SYNC");
    expect(result.stderr).not.toContain("HOST_CLEANUP_COMPLETE");
    expect(result.signal).toBe("SIGTERM");
    expect(result.workerAlive).toBe(false);
  });

  test("SIGINT with no host listener reaps the worker child and restores default termination", async () => {
    const childPath = writeChildScript();
    const result = await runSignalChild(childPath, "default", "SIGINT");
    expect(result.stderr).toContain("CLOSE_SYNC");
    expect(result.signal).toBe("SIGINT");
    expect(result.workerAlive).toBe(false);
  });

  test("pre-existing host once(SIGTERM) still finishes asynchronous cleanup", async () => {
    const childPath = writeChildScript();
    const result = await runSignalChild(childPath, "host-once-before");
    expect(result.stderr).toContain("CLOSE_SYNC");
    expect(result.stderr).toContain("HOST_ONCE_START");
    expect(result.stderr).toContain("HOST_CLEANUP_COMPLETE");
    expect(result.code).toBe(42);
    expect(result.signal).toBeNull();
    expect(result.workerAlive).toBe(false);
  });

  test("a second SIGTERM after a one-shot host listener restores default termination", async () => {
    const childPath = writeChildScript();
    const result = await runSignalChild(childPath, "host-once-stay", "SIGTERM", {
      secondAfter: "HOST_ONCE_START",
    });
    expect(result.stderr).toContain("CLOSE_SYNC");
    expect(result.stderr).toContain("HOST_ONCE_START");
    expect(result.stderr).not.toContain("HOST_CLEANUP_COMPLETE");
    expect(result.signal).toBe("SIGTERM");
    expect(result.workerAlive).toBe(false);
  });

  test("a later SIGINT after a one-shot SIGTERM host listener restores default termination", async () => {
    const childPath = writeChildScript();
    const result = await runSignalChild(childPath, "host-once-stay", "SIGTERM", {
      secondAfter: "HOST_ONCE_START",
      secondSignal: "SIGINT",
    });
    expect(result.stderr).toContain("CLOSE_SYNC");
    expect(result.stderr).toContain("HOST_ONCE_START");
    expect(result.signal).toBe("SIGINT");
    expect(result.workerAlive).toBe(false);
  });
});

describe("fresh cloakSaidAs precedence", () => {
  test("fresh, digest, and stateless sessions all honour the turn override", async () => {
    const scheduler = new GlobalScheduler({
      maxGlobalWorkers: 2,
      maxPerAccountWorkers: 2,
      idleTimeoutMs: 60_000,
    });
    const coordinator = new SessionCoordinator({
      scheduler,
      mcpServer: getSharedMcpServer(),
      spawnFn: spawnFakeAcp,
      providerOptions: providerState(providerSaidAs),
    });
    const turnOptions = { providerOptions: providerState(turnSaidAs) };
    const expectedSystem = buildEffectiveSystemText(
      systemText,
      undefined,
      true,
      turnSaidAs,
    );
    const expectedDigest = outgoingSystemDigest(expectedSystem, true);
    const selection = {
      rawModelId: "gemini-3.8-flash",
      configModelValue: "gemini-3.8-flash",
    };

    try {
      const sessionId = `cloak-fresh-${Date.now()}`;
      const sessionKey = `${testAccount.slotKey}::${testAccount.accountRef}::${sessionId}`;
      const freshReq = {
        model: "gemini-3.8-flash",
        system: systemText,
        messages: [
          { role: "user" as const, content: [{ type: "text" as const, text: "hello" }] },
        ],
        tools: [],
        toolChoice: { type: "auto" as const },
        stream: true,
        thinkingEnabled: false,
        sessionId,
      };

      for await (const _ of coordinator.executeTurn(
        testAccount,
        freshReq,
        selection,
        turnOptions,
      )) {
        // drain
      }

      const fresh = coordinator.getActiveWorker(sessionKey);
      expect(fresh).toBeDefined();
      expect(fresh!.effectiveSystemPrompt).toBe(expectedSystem);
      expect(fresh!.effectiveSystemPrompt).toContain("turn-rewrite-xyz");
      expect(fresh!.effectiveSystemPrompt).not.toContain("provider-rewrite-xyz");
      expect(fresh!.outgoingSystemDigest).toBe(expectedDigest);

      const statelessReq = { ...freshReq, sessionId: null };
      const gen = coordinator.executeTurn(
        testAccount,
        statelessReq,
        selection,
        turnOptions,
      );
      const first = await gen.next();
      const live = scheduler.getActiveWorkers().filter((w) => w !== fresh);
      expect(live.length).toBeGreaterThan(0);
      expect(live[0]!.effectiveSystemPrompt).toBe(expectedSystem);
      expect(live[0]!.outgoingSystemDigest).toBe(expectedDigest);
      if (!first.done) {
        for await (const _ of gen) {
          // drain
        }
      }
    } finally {
      await scheduler.closeAll();
      scheduler.destroy();
    }
  });
});
