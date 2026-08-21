import { posix } from 'node:path';

/**
 * Python's own top-level standard-library module names, as a static, curated
 * list -- there is no live interpreter here to ask `sys.stdlib_module_names`.
 * Used only to guard the bare same-directory import case below: if a tracked
 * project happens to ship its own `queue.py` or `json.py`, a bare `import
 * queue` almost certainly still means the real stdlib module, not that file.
 * Deliberately generous rather than exhaustive-and-risky, matching the
 * "missed edge over wrong edge" bar used throughout this pass -- an unlisted,
 * genuinely obscure stdlib name only produces a wrong edge in the doubly-rare
 * case where a tracked project *also* ships a same-named top-level file.
 */
const STDLIB_MODULES = new Set([
  '__future__',
  'abc',
  'argparse',
  'array',
  'ast',
  'asyncio',
  'base64',
  'bisect',
  'builtins',
  'calendar',
  'cgi',
  'cgitb',
  'cmd',
  'codecs',
  'collections',
  'colorsys',
  'compileall',
  'concurrent',
  'configparser',
  'contextlib',
  'contextvars',
  'copy',
  'copyreg',
  'cProfile',
  'csv',
  'ctypes',
  'curses',
  'dataclasses',
  'datetime',
  'dbm',
  'decimal',
  'difflib',
  'dis',
  'doctest',
  'email',
  'encodings',
  'ensurepip',
  'enum',
  'errno',
  'faulthandler',
  'fcntl',
  'filecmp',
  'fileinput',
  'fnmatch',
  'fractions',
  'ftplib',
  'functools',
  'gc',
  'getopt',
  'getpass',
  'gettext',
  'glob',
  'graphlib',
  'grp',
  'gzip',
  'hashlib',
  'heapq',
  'hmac',
  'html',
  'http',
  'imaplib',
  'importlib',
  'inspect',
  'io',
  'ipaddress',
  'itertools',
  'json',
  'keyword',
  'locale',
  'logging',
  'lzma',
  'mailbox',
  'marshal',
  'math',
  'mimetypes',
  'mmap',
  'msvcrt',
  'multiprocessing',
  'operator',
  'os',
  'pathlib',
  'pdb',
  'pickle',
  'pickletools',
  'pkgutil',
  'platform',
  'plistlib',
  'poplib',
  'posix',
  'pprint',
  'profile',
  'pstats',
  'pty',
  'pwd',
  'py_compile',
  'pyclbr',
  'pydoc',
  'queue',
  'quopri',
  'random',
  're',
  'readline',
  'reprlib',
  'resource',
  'rlcompleter',
  'runpy',
  'sched',
  'secrets',
  'select',
  'selectors',
  'shelve',
  'shlex',
  'shutil',
  'signal',
  'site',
  'smtplib',
  'socket',
  'socketserver',
  'sqlite3',
  'ssl',
  'stat',
  'statistics',
  'string',
  'stringprep',
  'struct',
  'subprocess',
  'symtable',
  'sys',
  'sysconfig',
  'syslog',
  'tarfile',
  'telnetlib',
  'tempfile',
  'termios',
  'test',
  'textwrap',
  'threading',
  'time',
  'timeit',
  'tkinter',
  'token',
  'tokenize',
  'tomllib',
  'trace',
  'traceback',
  'tracemalloc',
  'tty',
  'turtle',
  'types',
  'typing',
  'unicodedata',
  'unittest',
  'urllib',
  'uuid',
  'venv',
  'warnings',
  'wave',
  'weakref',
  'webbrowser',
  'winreg',
  'winsound',
  'wsgiref',
  'xml',
  'xmlrpc',
  'zipapp',
  'zipfile',
  'zipimport',
  'zlib',
  'zoneinfo',
]);

/**
 * Resolve a Python specifier from `extractPythonImportSpecifiers` against the
 * tracked-path set. Two shapes, told apart by a leading dot:
 *
 * - **Relative** (`.foo`, `..pkg.sub`) -- level 1 (`.`) means the current
 *   package, the directory holding `fromPath`; each extra dot goes up one
 *   more directory, matching Python's own relative-import semantics.
 * - **Bare** (`foo`, no leading dot) -- resolved only against `fromPath`'s
 *   own directory (no going up, no searching elsewhere), and only when
 *   `foo` is not a well-known stdlib module name -- see `STDLIB_MODULES`.
 *   This is deliberately narrower than the relative case: a bare name is a
 *   much weaker signal (it could always be a real third-party package this
 *   pass has no visibility into), so same-directory-only is the one place
 *   the ambiguity is low enough to act on.
 *
 * Returns `null` when nothing in `trackedPaths` matches, same "missed edge
 * over wrong one" default used everywhere else in this pass.
 */
export function resolvePythonSpecifier(fromPath: string, specifier: string, trackedPaths: ReadonlySet<string>): string | null {
  const dotsMatch = specifier.match(/^\.+/);
  const level = dotsMatch ? dotsMatch[0].length : 0;

  if (level === 0 && STDLIB_MODULES.has(specifier)) return null;

  const segments = (level === 0 ? specifier : specifier.slice(level)).split('.').filter(Boolean);
  if (segments.length === 0) return null;

  let dir = posix.dirname(fromPath);
  for (let i = 1; i < level; i++) {
    dir = posix.dirname(dir);
  }

  const joined = posix.join(dir, ...segments);

  const moduleFile = `${joined}.py`;
  if (trackedPaths.has(moduleFile)) return moduleFile;

  const packageInit = posix.join(joined, '__init__.py');
  if (trackedPaths.has(packageInit)) return packageInit;

  return null;
}
