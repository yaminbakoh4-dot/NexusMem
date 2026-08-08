import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

/** Everything NexusMem stores lives under this directory in the repo root. */
export const WORKSPACE_DIR = '.nexusmem';

export interface Workspace {
  /** Repository root. */
  root: string;
  /** `<root>/.nexusmem` */
  dir: string;
  dbPath: string;
  configPath: string;
}

export function resolveWorkspace(repoRoot: string): Workspace {
  const dir = join(repoRoot, WORKSPACE_DIR);
  return {
    root: repoRoot,
    dir,
    dbPath: join(dir, 'memory.db'),
    configPath: join(dir, 'config.json'),
  };
}

export function isInitialized(ws: Workspace): boolean {
  return existsSync(ws.configPath);
}

export const ConfigSchema = z.object({
  version: z.literal(1),
  projectId: z.string().min(1),
  sources: z
    .object({
      git: z
        .object({
          enabled: z.boolean().default(true),
          /** Git date expression bounding how far back to ingest; null = all history. */
          since: z.string().nullable().default(null),
          includeMerges: z.boolean().default(true),
        })
        .default({ enabled: true, since: null, includeMerges: true }),
      shell: z
        .object({
          enabled: z.boolean().default(true),
          /** Lines kept from scrape-based (no-hook) history files each sync. */
          tailLines: z.number().int().positive().default(300),
        })
        .default({ enabled: true, tailLines: 300 }),
      /**
       * Opt-in, unlike git/shell: conversation transcripts are the source
       * most likely to contain something sensitive (a pasted credential,
       * confidential discussion), so this must be a deliberate choice, not
       * an automatic default. See docs/phase-2-spec.md.
       */
      conversation: z
        .object({
          enabled: z.boolean().default(false),
        })
        .default({ enabled: false }),
    })
    .default({
      git: { enabled: true, since: null, includeMerges: true },
      shell: { enabled: true, tailLines: 300 },
      conversation: { enabled: false },
    }),
  limits: z
    .object({
      maxFilesPerNode: z.number().int().positive().default(40),
      maxBodyChars: z.number().int().positive().default(4000),
    })
    .default({ maxFilesPerNode: 40, maxBodyChars: 4000 }),
});

export type NexusConfig = z.infer<typeof ConfigSchema>;

export function defaultConfig(projectId: string): NexusConfig {
  return ConfigSchema.parse({ version: 1, projectId });
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export async function readConfig(ws: Workspace): Promise<NexusConfig> {
  let raw: string;
  try {
    raw = await readFile(ws.configPath, 'utf8');
  } catch {
    throw new ConfigError(`Not initialized: ${ws.configPath} not found. Run \`nexusmem init\` first.`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`${ws.configPath} is not valid JSON: ${(err as Error).message}`);
  }

  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
    throw new ConfigError(`${ws.configPath} is invalid:\n${issues}`);
  }
  return result.data;
}

export async function writeConfig(ws: Workspace, config: NexusConfig): Promise<void> {
  await mkdir(ws.dir, { recursive: true });
  await writeFile(ws.configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

/**
 * Make the workspace ignore itself.
 *
 * A self-ignoring directory means `init` never has to edit the user's own
 * .gitignore -- one less surprising write into a repo we do not own.
 */
export async function writeWorkspaceGitignore(ws: Workspace): Promise<void> {
  await mkdir(ws.dir, { recursive: true });
  await writeFile(join(ws.dir, '.gitignore'), '# Machine-local derived data.\n*\n', 'utf8');
}
