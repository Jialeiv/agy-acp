import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO_ROOT = path.join(import.meta.dir, "..");
const HELPER = path.join(REPO_ROOT, "scripts", "release-artifact.sh");
const PUBLISH_HELPER = path.join(REPO_ROOT, "scripts", "npm-publish.sh");
const RELEASE_WORKFLOW = path.join(REPO_ROOT, ".github", "workflows", "release.yml");
const CI_WORKFLOW = path.join(REPO_ROOT, ".github", "workflows", "ci.yml");

const tempDirs: string[] = [];

function makeArtifactDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-release-artifacts-"));
  tempDirs.push(dir);
  return dir;
}

function writeFile(dir: string, name: string, contents = "archive"): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, contents);
  return file;
}

function runHelper(dir: string) {
  return spawnSync("bash", [HELPER, dir], {
    encoding: "utf8",
    env: { ...process.env, HOME: dir },
  });
}

function runPublish(options: {
  status: number;
  output: string;
  token?: string;
  skip?: boolean;
  archiveDir?: string;
}) {
  const dir = makeArtifactDir();
  const artifactDir = options.archiveDir
    ? path.join(dir, options.archiveDir)
    : dir;
  fs.mkdirSync(artifactDir, { recursive: true });
  const archive = writeFile(artifactDir, "magpie-agy-acp-0.1.12.tgz");
  const binDir = path.join(dir, "bin");
  fs.mkdirSync(binDir);
  const fakeNpm = path.join(binDir, "npm");
  fs.writeFileSync(
    fakeNpm,
    "#!/usr/bin/env bash\nprintf '%s\\n' \"${FAKE_NPM_OUTPUT:-}\"\nprintf '%s\\n' \"${FAKE_NPM_ARG:-}\" > \"${FAKE_NPM_ARGS_FILE}\"\nexit \"${FAKE_NPM_STATUS:-0}\"\n",
  );
  fs.chmodSync(fakeNpm, 0o755);
  const argsFile = path.join(dir, "npm-args");
  const result = spawnSync("bash", [PUBLISH_HELPER, archive], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      HOME: dir,
      RUNNER_TEMP: dir,
      NPM_TOKEN: options.token ?? "",
      SKIP_NPM_PUBLISH: options.skip ? "true" : "",
      FAKE_NPM_STATUS: String(options.status),
      FAKE_NPM_OUTPUT: options.output,
      FAKE_NPM_ARG: options.archiveDir ? archive : "",
      FAKE_NPM_ARGS_FILE: argsFile,
    },
  });
  const called = fs.existsSync(argsFile);
  return {
    result,
    called,
    args: called ? fs.readFileSync(argsFile, "utf8").trim() : "",
    archive,
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("release artifact selection", () => {
  test("prints the only archive in the directory", () => {
    const dir = makeArtifactDir();
    const archive = writeFile(dir, "magpie-agy-acp-0.1.12.tgz");

    const result = runHelper(dir);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(archive);
    expect(result.stderr).toBe("");
  });

  test("fails when the directory has no archive", () => {
    const result = runHelper(makeArtifactDir());

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("expected exactly one .tgz");
    expect(result.stderr).toContain("found 0");
  });

  test("fails rather than choosing between multiple archives", () => {
    const dir = makeArtifactDir();
    writeFile(dir, "magpie-agy-acp-0.1.10.tgz");
    writeFile(dir, "magpie-agy-acp-0.1.12.tgz");

    const result = runHelper(dir);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("expected exactly one .tgz");
    expect(result.stderr).toContain("found 2");
    expect(result.stderr).toContain("0.1.10");
    expect(result.stderr).toContain("0.1.12");
  });

  test("ignores non-archives and nested files", () => {
    const dir = makeArtifactDir();
    const archive = writeFile(dir, "magpie-agy-acp-0.1.12.tgz");
    writeFile(dir, "package.json", "{}");
    fs.mkdirSync(path.join(dir, "nested"));
    writeFile(path.join(dir, "nested"), "other.tgz");

    const result = runHelper(dir);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(archive);
  });

  test("rejects an empty archive", () => {
    const dir = makeArtifactDir();
    writeFile(dir, "magpie-agy-acp-0.1.12.tgz", "");

    const result = runHelper(dir);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("release artifact is empty");
  });
});

describe("release workflow artifact handling", () => {
  const release = fs.readFileSync(RELEASE_WORKFLOW, "utf8");
  const ci = fs.readFileSync(CI_WORKFLOW, "utf8");

  test("packs into a dedicated directory and uploads only that exact path", () => {
    expect(release).toContain("--pack-destination");
    expect(release).toContain("steps.pack.outputs.tarball_path");
    expect(release).toContain("name: npm-tarball");
    expect(release).not.toContain("magpie-agy-acp-*.tgz");
  });

  test("resolves exactly one downloaded archive before publishing or releasing", () => {
    expect(release.match(/release-artifact\.sh/g)?.length).toBeGreaterThanOrEqual(2);
    expect(release.match(/path: \$\{\{ runner\.temp \}\}\/release-artifact/g)?.length).toBe(2);
    expect(release).toContain('bash scripts/npm-publish.sh "$ARTIFACT_PATH"');
    expect(release).toContain('gh release upload "$TAG" "$ARTIFACT_PATH"');
    expect(release).toContain('gh release create "$TAG" "$ARTIFACT_PATH"');
  });

  test("publishes through the checked failure-policy helper", () => {
    expect(release).toContain('bash scripts/npm-publish.sh "$ARTIFACT_PATH"');
    expect(release).toContain("SKIP_NPM_PUBLISH: ${{ vars.SKIP_NPM_PUBLISH }}");
  });

  test("propagates every npm failure without an explicit opt-out", () => {
    for (const output of [
      "npm error code E401",
      "npm error code E403",
      "npm error code E404",
      "npm error network request failed",
      "npm error You cannot publish over the previously published versions",
    ]) {
      const failed = runPublish({ status: 7, output });
      expect(failed.result.status).toBe(7);
      expect(failed.result.stderr).toContain("npm publish failed (exit 7)");
    }

    const tokenFailure = runPublish({
      status: 9,
      output: "npm error code E404",
      token: "token",
    });
    expect(tokenFailure.result.status).toBe(9);
  });

  test("SKIP_NPM_PUBLISH=true makes no npm call and succeeds", () => {
    const skipped = runPublish({ status: 1, output: "should not run", skip: true });

    expect(skipped.result.status).toBe(0);
    expect(skipped.called).toBe(false);
    expect(skipped.args).toBe("");
    expect(skipped.result.stdout).toContain("SKIP_NPM_PUBLISH=true");
    expect(skipped.result.stderr).toBe("");
  });

  test("passes the exact archive path as one argument", () => {
    const success = runPublish({
      status: 0,
      output: "published",
      archiveDir: "artifact dir",
    });

    expect(success.result.status).toBe(0);
    expect(success.called).toBe(true);
    expect(success.args).toBe(success.archive);
  });

  test("refuses an empty archive before invoking npm", () => {
    const dir = makeArtifactDir();
    const archive = writeFile(dir, "magpie-agy-acp-0.1.12.tgz", "");

    const result = spawnSync("bash", [PUBLISH_HELPER, archive], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: dir,
        RUNNER_TEMP: dir,
        SKIP_NPM_PUBLISH: "",
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("missing or empty");
  });

  test("does not silently re-resolve dependencies when the lockfile is stale", () => {
    expect(ci).not.toContain("|| bun install");
    expect(release).not.toContain("|| bun install");
  });

  test("documents the explicit publish opt-out", () => {
    expect(fs.readFileSync(path.join(REPO_ROOT, "README.md"), "utf8")).toContain(
      "SKIP_NPM_PUBLISH=true",
    );
  });

  test("ignores release archives and does not keep the obsolete tracked one", () => {
    expect(fs.readFileSync(path.join(REPO_ROOT, ".gitignore"), "utf8")).toMatch(/^\*\.tgz$/m);
    expect(fs.existsSync(path.join(REPO_ROOT, "magpie-agy-acp-0.1.10.tgz"))).toBe(false);
  });
});
