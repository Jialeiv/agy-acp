import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { LoopbackMcpServer } from "../src/mcp/http-server";
import { SessionToolBroker } from "../src/mcp/broker";
import type { ExposedToolCall, SessionToolBrokerOptions } from "../src/mcp/broker";
import {
  normalizeToolDefinitions,
  RESERVED_MCP_TOOL_NAMES,
} from "../src/mcp/schema/sanitizer";
import {
  decodeImageRgba,
  fitInlineImage,
  MAX_INLINE_IMAGE_SIDE,
  readImageDimensions,
} from "../src/protocol/images";

const ISOLATED_ENV_KEYS = [
  "HOME",
  "AGY_ACP_DATA_DIR",
  "ANTIGRAVITY_MAGPIE_DATA_DIR",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
] as const;

let origEnv: Record<(typeof ISOLATED_ENV_KEYS)[number], string | undefined> = {
  HOME: undefined,
  AGY_ACP_DATA_DIR: undefined,
  ANTIGRAVITY_MAGPIE_DATA_DIR: undefined,
  XDG_CONFIG_HOME: undefined,
  XDG_CACHE_HOME: undefined,
};
let tempRoot = "";

beforeAll(() => {
  origEnv = {
    HOME: process.env.HOME,
    AGY_ACP_DATA_DIR: process.env.AGY_ACP_DATA_DIR,
    ANTIGRAVITY_MAGPIE_DATA_DIR: process.env.ANTIGRAVITY_MAGPIE_DATA_DIR,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
  };
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agy-protocol-audit-"));
  process.env.HOME = path.join(tempRoot, "home");
  process.env.AGY_ACP_DATA_DIR = path.join(tempRoot, "data");
  process.env.ANTIGRAVITY_MAGPIE_DATA_DIR = path.join(tempRoot, "magpie");
  process.env.XDG_CONFIG_HOME = path.join(tempRoot, "config");
  process.env.XDG_CACHE_HOME = path.join(tempRoot, "cache");
  for (const key of ISOLATED_ENV_KEYS) {
    fs.mkdirSync(process.env[key]!, { recursive: true });
  }
});

afterAll(() => {
  for (const key of ISOLATED_ENV_KEYS) {
    const previous = origEnv[key];
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(probe: () => T | undefined, timeoutMs = 3000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await sleep(5);
  }
}

interface TestBridge {
  broker: SessionToolBroker;
  server: LoopbackMcpServer;
  url: string;
  batches: ExposedToolCall[][];
  close: () => void;
}

const openBridges: TestBridge[] = [];

function startBridge(options: SessionToolBrokerOptions = {}): TestBridge {
  const batches: ExposedToolCall[][] = [];
  const broker = new SessionToolBroker({
    ...options,
    onBatchReady: (calls) => {
      batches.push(calls);
      options.onBatchReady?.(calls);
    },
  });
  const server = new LoopbackMcpServer();
  const session = server.registerSession(broker);
  const bridge: TestBridge = {
    broker,
    server,
    url: session.url,
    batches,
    close: () => {
      broker.cancelAll("test finished");
      server.stop();
    },
  };
  openBridges.push(bridge);
  return bridge;
}

afterEach(() => {
  while (openBridges.length) {
    openBridges.pop()?.close();
  }
});

function rpc(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function callTool(
  url: string,
  name: string,
  args: unknown = {},
  id: number | string = 1,
): Promise<Response> {
  return rpc(url, { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
}

async function readBody(response: Response): Promise<{
  jsonrpc: string;
  id: unknown;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}> {
  return (await response.json()) as {
    jsonrpc: string;
    id: unknown;
    result?: Record<string, unknown>;
    error?: { code: number; message: string };
  };
}

const echoToolSchema = {
  type: "object",
  properties: { text: { type: "string" } },
  required: ["text"],
};

function writeU16LE(bytes: number[], value: number): void {
  bytes.push(value & 0xff, (value >> 8) & 0xff);
}

/** Literal GIF LZW: Clear around every pixel so the stream never depends on dictionary growth. */
function encodeGifLzw(indices: Uint8Array, minCodeSize: number): Uint8Array {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  const codeSize = minCodeSize + 1;
  const out: number[] = [];
  let bitBuffer = 0;
  let bitCount = 0;
  const emit = (code: number, size: number): void => {
    bitBuffer |= code << bitCount;
    bitCount += size;
    while (bitCount >= 8) {
      out.push(bitBuffer & 0xff);
      bitBuffer >>= 8;
      bitCount -= 8;
    }
  };

  emit(clear, codeSize);
  for (const pixel of indices) {
    emit(pixel, codeSize);
    emit(clear, codeSize);
  }
  emit(eoi, codeSize);
  if (bitCount > 0) out.push(bitBuffer & 0xff);
  return Uint8Array.from(out);
}

function packSubBlocks(data: Uint8Array): number[] {
  const out: number[] = [];
  let offset = 0;
  while (offset < data.length) {
    const n = Math.min(255, data.length - offset);
    out.push(n);
    for (let i = 0; i < n; i += 1) out.push(data[offset + i]!);
    offset += n;
  }
  out.push(0);
  return out;
}

function interlacedRowOrder(height: number): number[] {
  const rows: number[] = [];
  for (const [start, step] of [
    [0, 8],
    [4, 8],
    [2, 4],
    [1, 2],
  ] as const) {
    for (let y = start; y < height; y += step) rows.push(y);
  }
  return rows;
}

function encodeGif(options: {
  width: number;
  height: number;
  frames: Array<{ indices: Uint8Array; interlaced?: boolean }>;
  comment?: Uint8Array;
}): Uint8Array {
  const { width, height, frames, comment } = options;
  const bytes: number[] = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61];
  writeU16LE(bytes, width);
  writeU16LE(bytes, height);
  bytes.push(0x80, 0, 0);
  bytes.push(0xff, 0x00, 0x00, 0x00, 0x00, 0xff);
  if (comment && comment.length > 0) {
    bytes.push(0x21, 0xfe);
    bytes.push(...packSubBlocks(comment));
  }
  for (const frame of frames) {
    bytes.push(0x2c);
    writeU16LE(bytes, 0);
    writeU16LE(bytes, 0);
    writeU16LE(bytes, width);
    writeU16LE(bytes, height);
    bytes.push(frame.interlaced ? 0x40 : 0x00);
    bytes.push(2);
    let storage = frame.indices;
    if (frame.interlaced) {
      const order = interlacedRowOrder(height);
      storage = new Uint8Array(width * height);
      for (let i = 0; i < order.length; i += 1) {
        const y = order[i]!;
        storage.set(frame.indices.subarray(y * width, y * width + width), i * width);
      }
    }
    bytes.push(...packSubBlocks(encodeGifLzw(storage, 2)));
  }
  bytes.push(0x3b);
  return Uint8Array.from(bytes);
}

function solidIndices(width: number, height: number, color: number): Uint8Array {
  return new Uint8Array(width * height).fill(color);
}

describe("reserved MCP tool name mapping", () => {
  test("normalizeToolDefinitions rewrites await_result and keeps the original reverse mapping", () => {
    expect(RESERVED_MCP_TOOL_NAMES).toContain("await_result");
    const normalized = normalizeToolDefinitions([
      { name: "await_result", description: "caller tool", inputSchema: echoToolSchema },
      { name: "echo_tool", inputSchema: echoToolSchema },
    ]);
    expect(normalized.tools).toHaveLength(2);
    const caller = normalized.tools.find((tool) => tool.originalName === "await_result");
    expect(caller).toBeDefined();
    expect(caller?.mcpName).not.toBe("await_result");
    expect(normalized.originalToMcp.get("await_result")).toBe(caller?.mcpName);
    expect(normalized.mcpToOriginal.get(caller!.mcpName)).toBe("await_result");
    expect(normalized.mcpToOriginal.get("await_result")).toBeUndefined();
    expect(normalized.originalToMcp.get("echo_tool")).toBe("echo_tool");
    expect(new Set(normalized.tools.map((tool) => tool.mcpName)).size).toBe(2);
  });

  test("tools/list stays unique and the original caller tool still parks", async () => {
    const bridge = startBridge();
    const tools = bridge.broker.setTools([
      { name: "await_result", description: "caller await_result", inputSchema: echoToolSchema },
    ]);
    expect(tools).toHaveLength(1);
    expect(tools[0]?.originalName).toBe("await_result");
    expect(tools[0]?.mcpName).not.toBe("await_result");

    const list = await readBody(await rpc(bridge.url, { jsonrpc: "2.0", id: 1, method: "tools/list" }));
    const listed = (list.result?.tools ?? []) as Array<{ name: string }>;
    const names = listed.map((tool) => tool.name);
    expect(names).toContain("await_result");
    expect(names).toContain(tools[0]!.mcpName);
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);

    bridge.broker.openTurnWindow();
    const pending = callTool(bridge.url, tools[0]!.mcpName, { text: "from-caller" }, 2);
    const batch = await waitFor(() => bridge.batches[0]);
    expect(batch).toHaveLength(1);
    expect(batch[0]?.name).toBe("await_result");
    expect(batch[0]?.mcpName).toBe(tools[0]?.mcpName);
    expect(batch[0]?.input).toEqual({ text: "from-caller" });

    bridge.broker.deliverToolResults([
      { toolUseId: batch[0]!.id, isError: false, content: [{ type: "text", text: "ok" }] },
    ]);
    const body = await readBody(await pending);
    expect(body.result).toEqual({ content: [{ type: "text", text: "ok" }] });

    const relay = await readBody(await callTool(bridge.url, "await_result", { call_id: "toolu_missing" }, 3));
    const result = relay.result as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("No tool call");
  });
});

describe("GIF fitting vs animated passthrough", () => {
  test("oversized animated GIF is returned unchanged", () => {
    const width = MAX_INLINE_IMAGE_SIDE + 1;
    const height = 1;
    const gif = encodeGif({
      width,
      height,
      frames: [
        { indices: solidIndices(width, height, 0) },
        { indices: solidIndices(width, height, 1) },
      ],
    });
    expect(readImageDimensions(gif)).toEqual({ width, height, format: "gif" });
    const data = Buffer.from(gif).toString("base64");
    expect(fitInlineImage("image/gif", data)).toEqual({ mediaType: "image/gif", data });
  });

  test("oversized still GIF is fitted even when comments contain 0x2c", () => {
    const width = MAX_INLINE_IMAGE_SIDE + 1;
    const height = 1;
    const gif = encodeGif({
      width,
      height,
      frames: [{ indices: solidIndices(width, height, 0) }],
      comment: Uint8Array.from([0x2c, 0x2c, 0x2c, 0x21, 0x2c]),
    });
    const decoded = decodeImageRgba(gif);
    expect(decoded).not.toBeNull();
    expect(decoded?.width).toBe(width);
    expect(decoded?.height).toBe(height);
    expect(decoded?.rgba[0]).toBe(255);

    const data = Buffer.from(gif).toString("base64");
    const fitted = fitInlineImage("image/gif", data);
    expect(fitted.mediaType).toBe("image/png");
    expect(fitted.data).not.toBe(data);
    expect(readImageDimensions(Buffer.from(fitted.data, "base64"))).toEqual({
      width: MAX_INLINE_IMAGE_SIDE,
      height: 1,
      format: "png",
    });
  });

  test("oversized interlaced still GIF is fitted", () => {
    const width = MAX_INLINE_IMAGE_SIDE + 1;
    const height = 8;
    const indices = new Uint8Array(width * height);
    for (let y = 0; y < height; y += 1) {
      indices.fill(y % 2, y * width, y * width + width);
    }
    const gif = encodeGif({
      width,
      height,
      frames: [{ indices, interlaced: true }],
    });
    const decoded = decodeImageRgba(gif);
    expect(decoded).not.toBeNull();
    expect(decoded?.rgba[0]).toBe(255);
    expect(decoded?.rgba[(1 * width) * 4]).toBe(0);

    const data = Buffer.from(gif).toString("base64");
    const fitted = fitInlineImage("image/gif", data);
    expect(fitted.mediaType).toBe("image/png");
    const fittedDims = readImageDimensions(Buffer.from(fitted.data, "base64"));
    expect(fittedDims?.format).toBe("png");
    expect(fittedDims?.width).toBe(MAX_INLINE_IMAGE_SIDE);
    expect(fittedDims?.height).toBe(8);
  });

  test("malformed oversized GIF is passed through", () => {
    const gif = new Uint8Array([
      0x47, 0x49, 0x46, 0x38, 0x39, 0x61,
      0xd1, 0x07, 0x01, 0x00,
      0x00, 0x00, 0x00,
      0x00,
    ]);
    expect(readImageDimensions(gif)).toEqual({
      width: MAX_INLINE_IMAGE_SIDE + 1,
      height: 1,
      format: "gif",
    });
    const data = Buffer.from(gif).toString("base64");
    expect(fitInlineImage("image/gif", data)).toEqual({ mediaType: "image/gif", data });
    expect(decodeImageRgba(gif)).toBeNull();
  });
});
