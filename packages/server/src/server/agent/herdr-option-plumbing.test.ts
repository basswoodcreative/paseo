/**
 * Regression coverage for the fork's Herdr option plumbing.
 *
 * Every other Herdr test builds `PiRpcAgentClient` by hand and hands it either an
 * injected `herdrClient` or a `providerParams` record. Neither exists in production:
 * the registry factory (`provider-registry.ts`, the `pi:` entry) calls
 * `new PiRpcAgentClient({ logger, runtimeSettings })`, and Herdr options arrive on
 * each call. That is why the Herdr tests stayed green while the feature was
 * permanently off -- they exercised a constructor contract the daemon never sends.
 *
 * These tests take the only path the daemon takes (`buildProviderRegistry`) and
 * observe the Herdr CLI process itself, which is what an operator experiences as the
 * "Live Pi:" rows appearing or not. The fake binary is a real spawn, so nothing here
 * depends on a mock being wired the way the product is.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";

import { buildProviderRegistry } from "./provider-registry.js";

/** Stand-in for the `herdr` CLI: records its argv, answers with one Pi agent. */
const FAKE_HERDR_SCRIPT = `
const fs = require("node:fs");
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.HERDR_FAKE_LOG, argv.join(" ") + "\\n");
const agent = {
  id: "pane-1",
  name: "firstmate",
  kind: "pi",
  status: "idle",
  cwd: process.env.HERDR_FAKE_CWD,
  pane_id: "%7",
  agent_session: { id: "native-pi-session", file: process.env.HERDR_FAKE_SESSION_FILE },
};
const isGet = argv[0] === "agent" && argv[1] === "get";
const result = isGet ? { type: "agent", agent } : { type: "agent_list", agents: [agent] };
process.stdout.write(JSON.stringify({ id: "cli:agent:list", result }));
`;

interface Fixture {
  dir: string;
  cwd: string;
  sessionDir: string;
  sessionFile: string;
  logPath: string;
  fakeCommand: string[];
}

function createFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "herdr-option-plumbing-"));
  const sessionDir = join(dir, "pi-sessions");
  mkdirSync(sessionDir, { recursive: true });
  const cwd = join(dir, "project");
  mkdirSync(cwd, { recursive: true });
  const sessionFile = join(sessionDir, "native.jsonl");
  writeFileSync(
    sessionFile,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id: "native-pi-session",
      cwd,
      timestamp: new Date("2026-10-19T00:00:00.000Z").toISOString(),
    })}\n`,
  );
  const logPath = join(dir, "herdr-calls.log");
  writeFileSync(logPath, "");
  const fakeBinary = join(dir, "fake-herdr.cjs");
  writeFileSync(fakeBinary, FAKE_HERDR_SCRIPT);
  chmodSync(fakeBinary, 0o755);
  return {
    dir,
    cwd,
    sessionDir,
    sessionFile,
    logPath,
    fakeCommand: [process.execPath, fakeBinary],
  };
}

/** The Herdr CLI invocations the fake recorded, one per line. */
function recordedCalls(fixture: Fixture): string[] {
  const text = readFileSync(fixture.logPath, "utf8").trim();
  return text ? text.split("\n") : [];
}

function herdrConfig(fixture: Fixture, session: string) {
  return { enabled: true, command: fixture.fakeCommand, session };
}

describe("Herdr options reach the Pi provider through the registry factory", () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = createFixture();
    process.env.HERDR_FAKE_CWD = fixture.cwd;
    process.env.HERDR_FAKE_SESSION_FILE = fixture.sessionFile;
  });

  afterEach(() => {
    rmSync(fixture.dir, { recursive: true, force: true });
    delete process.env.HERDR_FAKE_LOG;
    delete process.env.HERDR_FAKE_CWD;
    delete process.env.HERDR_FAKE_SESSION_FILE;
  });

  async function listWithConfiguredPi(piOptions: Record<string, unknown>) {
    process.env.HERDR_FAKE_LOG = fixture.logPath;
    const registry = buildProviderRegistry(createTestLogger(), {
      providerOverrides: { pi: piOptions },
    });
    // No providerParams, no injected herdrClient: exactly what the daemon sends.
    const client = registry.pi.createClient(createTestLogger());
    const sessions = await client.listImportableSessions!({});
    return sessions.map((session) => session.title ?? null);
  }

  test("config `options` with herdr enabled queries the Herdr CLI", async () => {
    const titles = await listWithConfiguredPi({
      options: { sessionDir: fixture.sessionDir, herdr: herdrConfig(fixture, "paseo") },
    });

    expect(recordedCalls(fixture)).toContain("agent list --session paseo");
    expect(titles).toContain("Live Pi: firstmate");
  });

  test("the deprecated `params` spelling queries it too", async () => {
    const titles = await listWithConfiguredPi({
      params: { sessionDir: fixture.sessionDir, herdr: herdrConfig(fixture, "paseo") },
    });

    expect(recordedCalls(fixture)).toContain("agent list --session paseo");
    expect(titles).toContain("Live Pi: firstmate");
  });

  test("herdr stays unqueried when it is not configured", async () => {
    const titles = await listWithConfiguredPi({
      options: { sessionDir: fixture.sessionDir },
    });

    // "Disabled" must stay silent. This ticket fixes option plumbing; it must not turn
    // every Pi listing into a Herdr subprocess.
    expect(recordedCalls(fixture)).toEqual([]);
    expect(titles).not.toContain("Live Pi: firstmate");
  });
});
