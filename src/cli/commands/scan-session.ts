import pc from 'picocolors';
import { collectSessionSummaries } from '../../collectors/sessions.js';
import { collectClaudeCodeTranscripts } from '../../conversation/claude-code-reader.js';
import { claudeProjectTranscriptDir } from '../../conversation/paths.js';
import { makeProjectId } from '../../core/project.js';
import { readRepoInfo } from '../../git/repo.js';
import { DEFAULT_SLM_MODEL, OllamaChatProvider } from '../../slm/provider.js';
import { buildSessionPrompt, groupTurnsIntoSessions, selectSettledSessions } from '../../slm/summarize.js';

export interface ScanSessionOptions {
  cwd: string;
  model: string;
  settleMinutes: number;
  maxSessions: number;
  /** Show what would be sent to the model, and send nothing. */
  dryRun: boolean;
  json: boolean;
}

/**
 * Preview session summarization without writing anything to the database.
 *
 * `--dry-run` is the interesting mode: it prints the prompt each session
 * would produce, which is the only way to see what the model is actually
 * being shown after redaction and budget trimming.
 */
export async function runScanSession(opts: ScanSessionOptions): Promise<number> {
  const repo = await readRepoInfo(opts.cwd);
  const projectId = makeProjectId({ root: repo.root, originUrl: repo.originUrl });

  const turns = await collectClaudeCodeTranscripts(repo.root);
  if (turns.length === 0) {
    process.stderr.write(`${pc.yellow('no transcripts found')} at ${claudeProjectTranscriptDir(repo.root)}\n`);
    return 0;
  }

  const sessions = groupTurnsIntoSessions(turns);
  const settled = selectSettledSessions(sessions, opts.settleMinutes);

  if (!opts.json) {
    process.stderr.write(
      `${pc.dim('sessions')} ${sessions.length} found, ${settled.length} settled (quiet ${opts.settleMinutes}m+)\n\n`,
    );
  }

  if (opts.dryRun) {
    const previews = settled.slice(0, opts.maxSessions).map((session) => {
      const { prompt, hash, includedTurns } = buildSessionPrompt(session);
      return {
        sessionKey: session.sessionKey,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        turns: session.turns.length,
        includedTurns,
        hash,
        promptChars: prompt.length,
        prompt,
      };
    });

    if (opts.json) {
      process.stdout.write(`${JSON.stringify(previews, null, 2)}\n`);
      return 0;
    }

    for (const preview of previews) {
      process.stdout.write(
        `${pc.bold(preview.sessionKey)}  ${preview.startedAt.slice(0, 16).replace('T', ' ')}  ` +
          `${preview.includedTurns}/${preview.turns} turn(s), ${preview.promptChars} chars\n${preview.prompt}\n\n`,
      );
    }
    return 0;
  }

  const result = await collectSessionSummaries(turns, projectId, new OllamaChatProvider({ model: opts.model }), {
    settleMinutes: opts.settleMinutes,
    maxSessions: opts.maxSessions,
    onProgress: (done, total) => {
      if (!opts.json) process.stderr.write(`  ${pc.dim(`summarizing ${done}/${total}`)}\n`);
    },
  });

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(result.nodes, null, 2)}\n`);
    return 0;
  }

  for (const node of result.nodes) {
    process.stdout.write(`${pc.bold(node.title)}\n${pc.dim(node.ts.slice(0, 16).replace('T', ' '))}\n${node.body}\n\n`);
  }

  if (result.providerUnavailable) {
    process.stderr.write(
      `${pc.yellow('model unavailable')} -- is Ollama running with \`${opts.model}\` pulled? (\`ollama pull ${opts.model}\`)\n`,
    );
    return 0;
  }

  process.stderr.write(
    `${pc.bold(String(result.nodes.length))} summarized` +
      (result.failed > 0 ? `, ${pc.yellow(`${result.failed} failed`)}` : '') +
      ` ${pc.dim(`(model ${opts.model})`)}\n`,
  );
  return 0;
}

export const SCAN_SESSION_DEFAULT_MODEL = DEFAULT_SLM_MODEL;
