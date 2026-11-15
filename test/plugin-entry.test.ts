import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import plugin from "../src/index";
import {
  SESSION_ID_HEADER,
  SUBAGENT_HEADER,
} from "../src/protocol/anthropic";
import { PROVIDER_ID } from "../src/options";

const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "agy-plugin-entry-"));

const isolatedEnv = {
  HOME: path.join(TEMP_ROOT, "home"),
  AGY_ACP_DATA_DIR: path.join(TEMP_ROOT, "data"),
  ANTIGRAVITY_MAGPIE_DATA_DIR: path.join(TEMP_ROOT, "magpie"),
  XDG_CONFIG_HOME: path.join(TEMP_ROOT, "config"),
  XDG_CACHE_HOME: path.join(TEMP_ROOT, "cache"),
};

let origEnv: Record<string, string | undefined> = {};

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

describe("plugin entry fetch and headers", () => {
  test("count_tokens answers locally and rejects invalid JSON", async () => {
    const instance = await plugin.server();
    const loader = await instance.auth.loader(async () => {
      throw new Error("count_tokens must not ask for credentials");
    });

    const ok = await loader.fetch("agy://local/v1/count_tokens", {
      method: "POST",
      body: JSON.stringify({
        model: "gemini-3.8-flash",
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    expect(ok.status).toBe(200);
    const counted = (await ok.json()) as { input_tokens: number };
    expect(counted.input_tokens).toBeGreaterThanOrEqual(1);

    const bad = await loader.fetch("agy://local/v1/count_tokens", {
      method: "POST",
      body: "{not-json",
    });
    expect(bad.status).toBe(400);
    const body = (await bad.json()) as { error?: { type?: string; message?: string } };
    expect(body.error?.type).toBe("invalid_request_error");
    expect(body.error?.message).toContain("Invalid JSON");
  });

  test("chat.headers only injects session identity for this provider", async () => {
    const instance = await plugin.server();
    const headers: Record<string, string> = {};

    await instance["chat.headers"](
      {
        sessionID: "sess-other",
        model: { providerID: "openai" },
        subagentID: "agent-other",
      },
      { headers },
    );
    expect(headers[SESSION_ID_HEADER]).toBeUndefined();
    expect(headers[SUBAGENT_HEADER]).toBeUndefined();

    await instance["chat.headers"](
      {
        sessionID: "sess-ours",
        model: { providerID: PROVIDER_ID, subagentID: "agent-ours" },
      },
      { headers },
    );
    expect(headers[SESSION_ID_HEADER]).toBe("sess-ours");
    expect(headers[SUBAGENT_HEADER]).toBe("agent-ours");
  });
});
