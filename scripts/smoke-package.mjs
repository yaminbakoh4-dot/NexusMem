#!/usr/bin/env node
/**
 * Smoke test for the *packaged artifact*, not the source tree.
 *
 * Every defect that has ever reached an npm user of this package passed a
 * green unit suite first:
 *
 *   0.1.0  `bin` was `./dist/cli/index.js`. npm strips a bin entry whose path
 *          starts with `./` while building the *registry manifest*, so the
 *          package installed but exposed no `nexusmem` command.
 *   0.1.1  `--version` printed `0.1.0`, because the CLI carried a hardcoded
 *          literal separate from package.json and only the latter was bumped.
 *          `src/mcp/server.ts` reported the same stale version in its
 *          `initialize` handshake.
 *
 * Neither is reachable from `vitest`: one lives in npm's manifest handling and
 * the other only shows up when something actually executes the built binary.
 * So this script builds, packs, installs into a throwaway directory, and drives
 * the installed CLI the way a user would.
 *
 * Read this before adding a check: the tarball and the registry manifest are
 * two different artifacts. `npm pack` preserves a `./`-prefixed bin, so
 * installing a local tarball can NOT reproduce the 0.1.0 defect -- only
 * `npm publish --dry-run` reveals it, which is why checkPublishManifest()
 * exists as a separate step rather than an assertion on the install.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const expectedVersion = pkg.version;
const isWindows = process.platform === 'win32';
const npm = isWindows ? 'npm.cmd' : 'npm';

const results = [];

function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`  ok    ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err instanceof Error ? err.message : String(err)}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** Run to completion, capturing both streams. Never throws on a non-zero exit. */
function run(command, args, opts = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    // Windows resolves .cmd shims through the shell only. Every path handed to
    // a shelled-out command below is relative to `cwd` for that reason: a shell
    // command line is built by string concatenation, so an absolute temp path
    // would break the moment it contained a space.
    shell: opts.shell ?? false,
    ...opts,
  });
  if (result.error) throw result.error;
  return {
    status: result.status,
    // Carried deliberately: a process killed by a signal reports status null
    // and its cause only here, and that is the POSIX half of isCrash().
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

function runOk(command, args, opts = {}) {
  const result = run(command, args, opts);
  if (result.status !== 0) {
    const err = new Error(`${command} ${args.join(' ')} exited ${result.status}\n${result.output}`);
    err.exitStatus = result.status;
    err.signal = result.signal;
    throw err;
  }
  return result;
}

/**
 * This machine (and CI's Windows runner) intermittently tears git down mid-run:
 * the process reaches `close` carrying an NTSTATUS in the failure range --
 * 0xC0000005 in practice -- rather than an exit code git chose. `GitCrashError`
 * in src/git/exec.ts classifies exactly this, but the fixture setup below
 * spawns git directly and gets no such handling for free. Anything outside the
 * crash range is git's own verdict and must not be retried away.
 */
const NTSTATUS_FAILURE_FLOOR = 0xc0000000;
const STATUS_CONTROL_C_EXIT = 0xc000013a;

function isCrash(err) {
  if (err?.signal) return true; // killed by a signal rather than exiting
  const status = err?.exitStatus;
  return typeof status === 'number' && status >= NTSTATUS_FAILURE_FLOOR && status !== STATUS_CONTROL_C_EXIT;
}

/**
 * Retries the whole fixture rather than the individual command. `git add` and
 * `git commit` write, and a crashed write may or may not have landed, so
 * re-running one of them risks applying it twice or failing on a state the
 * first attempt already reached. Rebuilding from an empty directory has no
 * such ambiguity -- safe only because this fixture is a throwaway the script
 * owns exclusively.
 */
function withCrashRetry(label, attemptFn, attempts = 3) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return attemptFn();
    } catch (err) {
      if (!isCrash(err) || attempt >= attempts) throw err;
      console.log(`  note  ${label}: git was killed by the OS (${err.exitStatus}); retrying from scratch (${attempt}/${attempts - 1})`);
    }
  }
}

/**
 * The `initialize` handshake over a real stdio transport, which is the only
 * place an MCP client learns the server's version. Framing is newline-delimited
 * JSON-RPC, so no length prefix is involved.
 */
function mcpInitialize(cliPath, cwd, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, 'mcp'], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`no initialize response within ${timeoutMs}ms\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, timeoutMs);

    const finish = (fn, arg) => {
      clearTimeout(timer);
      child.kill();
      fn(arg);
    };

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      for (const line of stdout.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) continue;
        let message;
        try {
          message = JSON.parse(trimmed);
        } catch {
          continue; // a partial line; the next chunk completes it
        }
        if (message.id === 1) finish(resolve, message);
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (err) => finish(reject, err));
    child.on('exit', (code) => {
      if (stdout.includes('"id":1')) return;
      finish(reject, new Error(`server exited (${code}) before answering\nstdout: ${stdout}\nstderr: ${stderr}`));
    });

    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'nexusmem-smoke', version: '0.0.0' },
        },
      })}\n`,
    );
  });
}

/**
 * npm rewrites the manifest it sends to the registry and reports what it
 * changed as a *warning* -- exit status stays 0 -- so the output has to be
 * read. `--ignore-scripts` keeps `prepublishOnly` (typecheck + full suite +
 * build) from running a second time; nothing about manifest normalization
 * depends on it. Nothing is uploaded: `--dry-run` stops before the request.
 */
function checkPublishManifest() {
  // The precise defect, asserted structurally so it does not depend on npm's
  // wording: no bin path may start with `./`.
  const bin = typeof pkg.bin === 'string' ? { [pkg.name]: pkg.bin } : (pkg.bin ?? {});
  for (const [name, target] of Object.entries(bin)) {
    assert(
      !target.startsWith('./') && !target.startsWith('.\\'),
      `bin["${name}"] is "${target}"; npm drops a bin path prefixed with ./ when it builds the registry manifest, publishing a package with no executable`,
    );
  }

  // The general net, for whatever else npm decides to silently correct.
  //
  // The exit status is deliberately ignored. A dry run still talks to the
  // registry, so it fails whenever the current version is already published --
  // which is the normal state of this repository between releases -- and fails
  // again in CI, where there is no auth token. Neither has anything to do with
  // the manifest. What matters is that npm normalizes package.json and reports
  // its corrections *before* any of that, so the warnings are on the output
  // either way.
  const result = run(npm, ['publish', '--dry-run', '--ignore-scripts'], { cwd: repoRoot, shell: isWindows });
  // Positive evidence that the stage being audited actually ran. Without this
  // the check would pass silently if npm bailed out earlier than expected --
  // an absent warning would be read as a clean manifest.
  assert(
    /Tarball Contents/i.test(result.output),
    `npm never reached the packing stage, so the manifest was not audited (exit ${result.status}):\n${result.output}`,
  );
  assert(
    !/invalid and removed/i.test(result.output),
    `npm removed something from the published manifest:\n${result.output
      .split('\n')
      .filter((l) => /invalid and removed|auto-corrected/i.test(l))
      .join('\n')}`,
  );
  assert(
    !/auto-corrected/i.test(result.output),
    `npm auto-corrected package.json on publish, so the published manifest differs from this file:\n${result.output
      .split('\n')
      .filter((l) => /auto-corrected|npm warn publish/i.test(l))
      .join('\n')}`,
  );
  // npm's own verdict on whether `bin` points at something that exists. It is
  // only a warning, so it never fails a publish on its own.
  assert(
    !/No bin file found/i.test(result.output),
    `npm cannot find the file bin points at, so the published package would install no working command:\n${result.output
      .split('\n')
      .filter((l) => /No bin file found/i.test(l))
      .join('\n')}`,
  );

  // Every bin target must appear in the file listing -- scoped to the listing
  // itself, not the whole output.
  //
  // Scoping is the entire point. Matching the target against `result.output`
  // instead passes on `npm warn package-json ... No bin file found at
  // dist/cli/index.js`: an assertion meant to prove the entry point is present
  // succeeds *because* npm reported it absent. That is not hypothetical -- it
  // is what this check did until it was caught, and it made the audit run
  // against a dist-less tarball on CI without anything going red.
  const contents = result.output.split(/Tarball Contents/i)[1]?.split(/Tarball Details/i)[0] ?? '';
  for (const [name, target] of Object.entries(bin)) {
    const posix = target.replace(/\\/g, '/');
    assert(
      contents.split('\n').some((line) => line.includes(posix)),
      `bin["${name}"] points at ${target}, which is not among the packed files:\n${contents}`,
    );
  }
}

async function main() {
  const workRoot = mkdtempSync(path.join(tmpdir(), 'nexusmem-smoke-'));
  const consumer = path.join(workRoot, 'consumer');
  const project = path.join(workRoot, 'project');
  let exitCode = 0;

  console.log(`nexusmem smoke test — expecting version ${expectedVersion}`);
  console.log(`workspace: ${workRoot}\n`);

  try {
    // Build first. `dist/` is gitignored, so on a fresh checkout it does not
    // exist yet, and auditing the manifest before it does means auditing a
    // tarball with no entry point in it -- which is exactly what happened on
    // the first CI run of this script.
    console.log('build');
    runOk(npm, ['run', 'build'], { cwd: repoRoot, shell: isWindows });

    console.log('\npublish manifest');
    check('npm does not rewrite the manifest it would publish', checkPublishManifest);

    console.log('\npack and install');
    const packed = runOk(npm, ['pack', '--silent', '--pack-destination', workRoot], {
      cwd: repoRoot,
      shell: isWindows,
    });
    const tarball = packed.stdout.trim().split('\n').pop().trim();
    const tarballPath = path.join(workRoot, tarball);
    assert(existsSync(tarballPath), `npm pack reported ${tarball} but it is not on disk`);

    writeFileSync(
      path.join(mkdirp(consumer), 'package.json'),
      `${JSON.stringify({ name: 'nexusmem-smoke-consumer', version: '1.0.0', private: true }, null, 2)}\n`,
    );
    // Install by absolute path, then drive everything else by relative path.
    runOk(npm, ['install', tarballPath, '--no-audit', '--no-fund', '--loglevel=error'], {
      cwd: consumer,
      shell: isWindows,
    });

    const installedCli = path.join(consumer, 'node_modules', 'nexusmem', 'dist', 'cli', 'index.js');
    const shimRelative = path.join('node_modules', '.bin', isWindows ? 'nexusmem.cmd' : 'nexusmem');
    const shimAbsolute = path.join(consumer, shimRelative);
    // Each platform gets the only form that is unambiguous on it. Windows needs
    // a shell to run a .cmd, and a shell command line is concatenated rather
    // than quoted, so an absolute temp path would break on the first space --
    // hence the relative path, resolved by the shell against `cwd`. POSIX needs
    // no shell, and Node does not promise that a *relative* command is resolved
    // against the child's `cwd` rather than the parent's -- hence the absolute
    // path, which has no quoting hazard without a shell in the way.
    const shimCommand = isWindows ? shimRelative : shimAbsolute;

    console.log('\ninstalled artifact');
    check('the package installs and lands its entry point on disk', () => {
      assert(existsSync(installedCli), `${installedCli} is missing from the installed package`);
    });
    check('npm creates a nexusmem executable shim', () => {
      assert(existsSync(shimAbsolute), `${shimRelative} was not created by the install`);
    });
    check('the shim runs and reports the version in package.json', () => {
      const result = run(shimCommand, ['--version'], { cwd: consumer, shell: isWindows });
      assert(result.status === 0, `shim exited ${result.status}\n${result.output}`);
      assert(
        result.stdout.trim() === expectedVersion,
        `shim printed "${result.stdout.trim()}", package.json says "${expectedVersion}"`,
      );
    });

    console.log('\nend to end against a real repository');
    withCrashRetry('fixture repository', () => {
      rmSync(project, { recursive: true, force: true });
      mkdirp(project);
      runOk('git', ['init', '-q', '-b', 'main'], { cwd: project });
      // Identity is set per-fixture: CI runners have no global git identity,
      // and relying on this machine's would make the run environment-dependent.
      runOk('git', ['config', 'user.email', 'smoke@example.invalid'], { cwd: project });
      runOk('git', ['config', 'user.name', 'Smoke Test'], { cwd: project });
      writeFileSync(path.join(project, 'budget.txt'), 'the retrieval budget knob\n');
      runOk('git', ['add', '.'], { cwd: project });
      runOk('git', ['commit', '-q', '-m', 'feat: add the retrieval budget knob'], { cwd: project });
    });

    check('init creates the workspace', () => {
      runOk(process.execPath, [installedCli, 'init', '-C', project]);
      assert(existsSync(path.join(project, '.nexusmem', 'config.json')), '.nexusmem/config.json was not created');
    });
    check('sync ingests the repository', () => {
      // --no-embed: no embedding provider is reachable in CI, and the vector
      // pass is not what this script is here to prove.
      const result = runOk(process.execPath, [installedCli, 'sync', '-C', project, '--no-embed']);
      assert(/\d/.test(result.output), `sync printed no summary:\n${result.output}`);
    });
    check('query returns the commit that was just ingested', () => {
      const result = runOk(process.execPath, [installedCli, 'query', 'retrieval budget knob', '-C', project, '--no-vector']);
      assert(
        result.stdout.includes('retrieval budget knob'),
        `the ingested commit subject is absent from the packed context:\n${result.stdout}`,
      );
    });
    check('status reports what was ingested', () => {
      runOk(process.execPath, [installedCli, 'status', '-C', project]);
    });

    console.log('\nMCP stdio transport');
    let handshake;
    try {
      handshake = await mcpInitialize(installedCli, project);
    } catch (err) {
      handshake = err;
    }
    check('the server answers initialize over stdio', () => {
      assert(!(handshake instanceof Error), handshake instanceof Error ? handshake.message : '');
      assert(handshake?.result?.serverInfo, `no serverInfo in the response: ${JSON.stringify(handshake)}`);
    });
    check('initialize reports the version in package.json', () => {
      assert(!(handshake instanceof Error), 'handshake failed; see above');
      const reported = handshake?.result?.serverInfo?.version;
      assert(reported === expectedVersion, `initialize reported "${reported}", package.json says "${expectedVersion}"`);
    });

    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    if (failed.length > 0) {
      console.log(`failed: ${failed.map((r) => r.name).join(', ')}`);
      exitCode = 1;
    }
  } finally {
    try {
      rmSync(workRoot, { recursive: true, force: true });
    } catch {
      // A leftover temp directory is not a reason to fail the run.
    }
  }

  process.exit(exitCode);
}

function mkdirp(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

await main();
