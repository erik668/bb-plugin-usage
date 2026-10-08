import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";
import { GENERATED_MODULE, renderHostJsonCollectorModule } from "../scripts/build-host-json-collector.mjs";
import type * as HostJsonCollector from "./host-json-collector";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "bb-usage-bundling-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("host JSON collector bundling", () => {
  it("keeps the generated collector source in sync with its runtime module", async () => {
    expect(await readFile(GENERATED_MODULE, "utf8")).toBe(await renderHostJsonCollectorModule());
  });

  // bb >= 0.45 re-bundles plugin servers with minify + keepNames. A collector
  // shipped via Function.prototype.toString() then calls the bundle's renamed
  // `__name` helper on the host and every scan fails with "u is not defined".
  it("scans successfully when the server is re-bundled with minify and keepNames", async () => {
    const directory = await temporaryDirectory();
    const bundled = await build({
      entryPoints: [join(import.meta.dirname, "host-json-collector.ts")],
      bundle: true,
      write: false,
      format: "cjs",
      platform: "node",
      minify: true,
      keepNames: true,
      logLevel: "silent",
    });
    const modulePath = join(directory, "host-json-collector.cjs");
    await writeFile(modulePath, bundled.outputFiles[0]!.text);
    const collector = createRequire(import.meta.url)(modulePath) as typeof HostJsonCollector;

    const root = join(directory, "sessions");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "rollout-test.jsonl"), [
      { timestamp: "2026-08-09T12:00:00Z", type: "turn_context", payload: { model: "gpt-5.6-sol" } },
      { timestamp: "2026-08-09T12:00:01Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 60, cache_write_input_tokens: 5, output_tokens: 20 } } } },
    ].map((value) => JSON.stringify(value)).join("\n"));
    const script = collector.compressedHostJsonCollectorScript({
      agentId: "codex",
      roots: [root],
      cachePath: join(directory, "cache", "codex.json"),
      sinceDay: "2026-08-01",
    });

    const { stdout } = await execFileAsync(process.execPath, ["-e", script], { maxBuffer: 2 * 1024 * 1024 });
    const result = collector.extractHostJsonScan(stdout);
    expect(result).toMatchObject({ fileCount: 1, failureCount: 0 });
    expect(result.rows).toEqual([expect.objectContaining({ model: "gpt-5.6-sol", uncachedInputTokens: 40, outputTokens: 20 })]);
  });
});
