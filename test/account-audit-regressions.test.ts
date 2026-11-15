import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import type { AccountDescriptor } from "../src/types";
import {
  buildAgyEnvAndArgs,
  getPluginDataRoot,
  killProcessTree,
  redactSecrets,
  resolveIsolatedHomeDir,
} from "../src/accounts/env";
import { extractAuthorizationCode } from "../src/accounts/auth";
import { readProviderOptions } from "../src/options";
import { withEnv } from "./fixtures/helpers";

/**
 * Regressions from the account/runtime audit:
 * - `killProcessTree` skipped nothing because it required both exit and signal codes.
 * - `AGY_CLI_DISABLE_AUTO_UPDATE` could be re-enabled by an inherited value.
 * - a malformed callback URL echoed the authorization code back in its error.
 * - provider option defaults were seeded twice, and one copy disagreed with its spec.
 *
 * Nothing here spawns the real `agy`; account paths resolve to a throwaway file.
 * The suite pins every HOME/XDG/data variable to TEST_DIR for its whole lifetime.
 */
const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "magpie-account-audit-"));
const ISOLATED_ENV: Record<string, string> = {
  HOME: path.join(TEST_DIR, "home"),
  AGY_ACP_DATA_DIR: path.join(TEST_DIR, "data", "agy-acp"),
  ANTIGRAVITY_MAGPIE_DATA_DIR: path.join(TEST_DIR, "data", "magpie"),
  XDG_CONFIG_HOME: path.join(TEST_DIR, "config"),
  XDG_CACHE_HOME: path.join(TEST_DIR, "cache"),
};
const ACCOUNT_REF = "3f1c2a44-5b6d-4e7f-8a90-1b2c3d4e5f60";
const MOCK_AGY_BIN = path.join(
  TEST_DIR,
  process.platform === "win32" ? "mock-agy.cmd" : "mock-agy",
);
const savedEnv = new Map<string, string | undefined>();

/** Runs `fn` with `agy` resolution and the data dirs pinned inside TEST_DIR. */
async function withIsolatedDataDir<T>(
  overrides: Record<string, string | undefined>,
  fn: () => T,
): Promise<T> {
  return withEnv({ AGY_PATH: MOCK_AGY_BIN, ...overrides }, fn);
}

function isolatedAccount(): AccountDescriptor {
  return {
    slotKey: `agy-acp:${ACCOUNT_REF}`,
    accountRef: ACCOUNT_REF,
    mode: "isolated",
    label: "audit@example.com",
    isolatedHomeDir: resolveIsolatedHomeDir(ACCOUNT_REF),
  };
}

beforeAll(() => {
  for (const [key, value] of Object.entries(ISOLATED_ENV)) {
    savedEnv.set(key, process.env[key]);
    fs.mkdirSync(value, { recursive: true });
    process.env[key] = value;
  }
  const content =
    process.platform === "win32" ? "@echo off\r\nexit /b 0\r\n" : "#!/bin/sh\nexit 0\n";
  fs.writeFileSync(MOCK_AGY_BIN, content, { mode: 0o755 });
});

afterAll(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("killProcessTree skips children that already exited", () => {
  /**
   * A reaped child used to fall through to the descendant scan because the guard
   * required both `exitCode` and `signalCode`, which Node never sets together.
   * The scan runs `ps` and re-signals whatever now holds the pid.
   */
  function fakeChild(state: {
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
  }): { child: ChildProcess; killCalls: NodeJS.Signals[] } {
    const killCalls: NodeJS.Signals[] = [];
    const child = {
      // Deliberately unreachable: any real signal would miss, never hit a live pid.
      pid: 0x7ffffff0,
      ...state,
      kill: (signal?: NodeJS.Signals) => {
        killCalls.push(signal ?? "SIGTERM");
        return true;
      },
    } as unknown as ChildProcess;
    return { child, killCalls };
  }

  test("a child with a normal exit code is not signaled again", () => {
    const { child, killCalls } = fakeChild({ exitCode: 0, signalCode: null });
    killProcessTree(child);
    expect(killCalls).toEqual([]);
  });

  test("a child killed by a signal is not signaled again", () => {
    const { child, killCalls } = fakeChild({ exitCode: null, signalCode: "SIGKILL" });
    killProcessTree(child);
    expect(killCalls).toEqual([]);
  });

  // Windows takes the `taskkill` branch and only falls back to `child.kill` on
  // failure, so this control only makes sense on the signal path.
  test.skipIf(process.platform === "win32")("a still-running child is signaled", () => {
    const { child, killCalls } = fakeChild({ exitCode: null, signalCode: null });
    killProcessTree(child);
    expect(killCalls).toEqual(["SIGKILL"]);
  });
});

describe("buildAgyEnvAndArgs enforces the hard environment rules", () => {
  test("inherited AGY_CLI_DISABLE_AUTO_UPDATE values cannot re-enable updates", async () => {
    for (const inherited of ["false", "", "0", "no", undefined]) {
      await withIsolatedDataDir({ AGY_CLI_DISABLE_AUTO_UPDATE: inherited }, () => {
        const { env } = buildAgyEnvAndArgs(isolatedAccount(), ["acp"]);
        expect(env.AGY_CLI_DISABLE_AUTO_UPDATE).toBe("true");
        expect(env.BROWSER).toBe("/usr/bin/false");
      });
    }
  });

  test("the browser shim dir stays first on PATH", async () => {
    await withIsolatedDataDir({ AGY_CLI_DISABLE_AUTO_UPDATE: undefined }, () => {
      const { env } = buildAgyEnvAndArgs(isolatedAccount(), ["acp"]);
      expect(env.PATH?.startsWith(path.join(getPluginDataRoot(), "bin-shims"))).toBe(true);
    });
  });
});

describe("extractAuthorizationCode never echoes the authorization code", () => {
  const SECRET = "4/0AVERYREALSECRETVALUE";

  test("a malformed callback URL reports a fixed message", () => {
    // Bun's URL parse error embeds the raw input, and the input still carries `code=`.
    const malformed = `http://[::1]oops?code=${SECRET}&state=xyz`;

    let message = "";
    try {
      extractAuthorizationCode(malformed);
      throw new Error("expected extractAuthorizationCode to reject a malformed URL");
    } catch (err: any) {
      message = String(err?.message ?? err);
    }

    expect(message).toContain("Invalid callback URL");
    expect(message).not.toContain(SECRET);
    expect(message).not.toContain("state=xyz");
  });

  test("a well-formed callback URL still yields the code", () => {
    expect(
      extractAuthorizationCode(`https://antigravity.google/oauth-callback?code=${SECRET}&scope=openid`),
    ).toBe(SECRET);
    expect(() =>
      extractAuthorizationCode("https://antigravity.google/oauth-callback?error=access_denied"),
    ).toThrow("No authorization code found");
  });

  test("redactSecrets masks a code that reaches any other error path", () => {
    const redacted = redactSecrets(`token exchange failed: code=${SECRET}&state=xyz`);
    expect(redacted).not.toContain(SECRET);
    expect(redacted).toContain("code=[REDACTED]");
  });
});

describe("provider option defaults have a single source", () => {
  const BOOLEAN_KEYS = [
    "quotaRouting",
    "minimalAgent",
    "exposeThinking",
    "cloakPrompts",
    "accountFailover",
  ] as const;

  test("every boolean field is populated from its spec", async () => {
    await withEnv(
      {
        AGY_MAGPIE_QUOTA_ROUTING: undefined,
        AGY_MAGPIE_ACCOUNT_FAILOVER: undefined,
        AGY_MAGPIE_CLOAK_PROMPTS: undefined,
        AGY_MAGPIE_MINIMAL_AGENT: undefined,
        AGY_MAGPIE_EXPOSE_THINKING: undefined,
      },
      () => {
        const state = readProviderOptions(undefined, {});
        for (const key of BOOLEAN_KEYS) {
          expect(typeof state[key]).toBe("boolean");
        }
        // The spec fallback for expose_thinking is on; the deleted literal said off.
        expect(state.exposeThinking).toBe(true);
        expect(state.quotaRouting).toBe(true);
        expect(state.accountFailover).toBe(false);
        expect(state.cloakSaidAs).toBe("");
      },
    );
  });

  test("package options and live Magpie toggles still win over the fallback", async () => {
    await withEnv({ AGY_MAGPIE_EXPOSE_THINKING: undefined }, () => {
      const fromPkg = readProviderOptions(undefined, { expose_thinking: false });
      expect(fromPkg.exposeThinking).toBe(false);

      const fromMagpie = readProviderOptions({
        magpie: {
          option: (provider: string, key: string) =>
            provider === "agy-acp" && key === "expose_thinking" ? true : undefined,
          options: () => ({}),
        },
      });
      expect(fromMagpie.exposeThinking).toBe(true);
    });
  });
});
