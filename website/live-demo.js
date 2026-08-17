// Interactive terminal demo — replays REAL recorded output from bench/results/vite-final.json
// (produced by scripts/benchmark.ts against vitejs/vite). Nothing here is computed live; every
// number below was copied verbatim from that file so the on-page numbers can never drift from
// the source of truth. See the caveat text in index.html for why it's a replay, not a live exec.

const VITE_BENCH = [
  { q: "why does vite auto inject hmr client", source: "commit", ms: 688, nodes: 23, resolved: 20, touched: 30, tokens: 1996, baseFull: 90499, baseLog: 638641, saveFull: 0.977944507674118, saveLog: 0.99687461343697 },
  { q: "why does vite esbuild transform should filter id with and wihtout query", source: "commit", ms: 887, nodes: 30, resolved: 24, touched: 30, tokens: 1998, baseFull: 134668, baseLog: 1182714, saveFull: 0.9851635132325423, saveLog: 0.9983106651312151 },
  { q: "why does vite setup redirect (#4215)", source: "commit", ms: 1024, nodes: 38, resolved: 21, touched: 30, tokens: 1978, baseFull: 119707, baseLog: 2369590, saveFull: 0.9834763213512995, saveLog: 0.9991652564367676 },
  { q: "why does vite update all non-major dependencies (#8281)", source: "commit", ms: 1905, nodes: 23, resolved: 25, touched: 30, tokens: 1991, baseFull: 130417, baseLog: 6953632, saveFull: 0.9847335853454687, saveLog: 0.9997136748105163 },
  { q: "why does vite use typescript 5.0 in templates (#12481)", source: "commit", ms: 1900, nodes: 22, resolved: 29, touched: 30, tokens: 1991, baseFull: 173130, baseLog: 6843611, saveFull: 0.9884999711199677, saveLog: 0.9997090717166712 },
  { q: "why does vite improve dynamic import variable failure error message (#16519)", source: "commit", ms: 1021, nodes: 31, resolved: 15, touched: 30, tokens: 1988, baseFull: 79308, baseLog: 2214355, saveFull: 0.9749331719372573, saveLog: 0.9991022216401616 },
  { q: "why does vite make `viteMetadata` and `modules` enumerable (#261)", source: "commit", ms: 1214, nodes: 28, resolved: 26, touched: 30, tokens: 1977, baseFull: 255347, baseLog: 2469440, saveFull: 0.9922575945673926, saveLog: 0.9991994136322405 },
  { q: "why does vite fix match escaped dots to support $-prefixed define keys (#23249)", source: "commit", ms: 2162, nodes: 32, resolved: 30, touched: 30, tokens: 1990, baseFull: 261694, baseLog: 7535657, saveFull: 0.9923956987932471, saveLog: 0.9997359221631239 },
  { q: "What Vite Trusts", source: "doc", ms: 458, nodes: 24, resolved: 17, touched: 17, tokens: 1911, baseFull: 82381, baseLog: 648811, saveFull: 0.9768029035821366, saveLog: 0.99705461220602 },
  { q: "Motivation", source: "doc", ms: 1512, nodes: 28, resolved: 15, touched: 24, tokens: 1501, baseFull: 71263, baseLog: 744385, saveFull: 0.9789371763748369, saveLog: 0.9979835703298696 },
  { q: "`FetchResult`", source: "doc", ms: 708, nodes: 30, resolved: 22, touched: 30, tokens: 1981, baseFull: 81849, baseLog: 738147, saveFull: 0.975796894280932, saveLog: 0.9973162527247282 },
  { q: "JavaScript Minification by Oxc", source: "doc", ms: 2120, nodes: 24, resolved: 28, touched: 30, tokens: 1998, baseFull: 245637, baseLog: 7441388, saveFull: 0.9918660462389624, saveLog: 0.9997315017037144 },
  { q: "The Why", source: "doc", ms: 521, nodes: 33, resolved: 19, touched: 20, tokens: 1762, baseFull: 79895, baseLog: 549370, saveFull: 0.9779460541961325, saveLog: 0.9967926898083259 },
  { q: "SSR Externals", source: "doc", ms: 2091, nodes: 27, resolved: 15, touched: 30, tokens: 2000, baseFull: 223267, baseLog: 7354890, saveFull: 0.9910421154940049, saveLog: 0.999728072071778 },
  { q: "Why enable `checkJs` in the JS template?", source: "doc", ms: 672, nodes: 29, resolved: 22, touched: 30, tokens: 1996, baseFull: 17533, baseLog: 151859, saveFull: 0.8861575315120059, saveLog: 0.9868562284750986 },
  { q: "Forked deadlock description:", source: "doc", ms: 1893, nodes: 43, resolved: 15, touched: 30, tokens: 1990, baseFull: 163769, baseLog: 6931298, saveFull: 0.987848738161679, saveLog: 0.9997128964877863 },
];

(function () {
  const output = document.getElementById("psOutput");
  const input = document.getElementById("psInput");
  const chipRow = document.getElementById("psChips");
  if (!output || !input || !chipRow) return;

  const fmt = (n) => Math.round(n).toLocaleString("en-US");
  // extra precision above 99.95% so a save of e.g. 99.97% never displays as a misleading "100.0%"
  const pct = (n) => {
    const p = n * 100;
    return (p >= 99.95 ? p.toFixed(2) : p.toFixed(1)) + "%";
  };

  // rough tokens-per-page so raw token counts translate into something visual: OpenAI's own
  // rule of thumb is ~750 words per 1,000 tokens; at ~500 words/page that's ~667 tokens/page.
  const PAGE_TOKENS = 667;
  const pages = (tokens) => {
    const p = Math.round(tokens / PAGE_TOKENS);
    return p <= 1 ? "~1 page" : `~${p.toLocaleString("en-US")} pages`;
  };
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

  function scrollToEnd() {
    output.scrollTop = output.scrollHeight;
  }

  function printLine(html, cls) {
    const div = document.createElement("div");
    div.className = "ps-line" + (cls ? " " + cls : "");
    div.innerHTML = html;
    output.appendChild(div);
    scrollToEnd();
  }

  function printEcho(text) {
    printLine(`<span class="prompt">PS C:\\dev\\vite&gt;</span> ${escapeHtml(text)}`);
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function printResult(entry, matchedNote) {
    const block = document.createElement("div");
    block.className = "ps-line ps-result";
    let html = "";
    if (matchedNote) html += `<div class="muted">${matchedNote}</div>`;
    html += `<div class="ps-meta">${entry.nodes} nodes packed · ${entry.resolved}/${entry.touched} files resolved · <span class="hit-title">${fmt(entry.tokens)} tokens</span> <span class="muted">(${pages(entry.tokens)})</span> · ${entry.ms}ms</div>`;
    html += `<div class="ps-savings">`;
    html += `<div>full files &nbsp;${fmt(entry.baseFull)} tokens <span class="muted">(${pages(entry.baseFull)})</span> &rarr; <span class="save">${pct(entry.saveFull)} saved</span></div>`;
    html += `<div>git log dump ${fmt(entry.baseLog)} tokens <span class="muted">(${pages(entry.baseLog)})</span> &rarr; <span class="save">${pct(entry.saveLog)} saved</span></div>`;
    html += `</div>`;
    html += `<div class="muted ps-plain">so instead of reading ${pages(entry.baseFull)} of full files, your agent reads ${pages(entry.tokens)}.</div>`;
    block.innerHTML = html;
    output.appendChild(block);
    scrollToEnd();
  }

  function printHelp() {
    printLine(
      `<div class="muted">Commands: <span class="hit-title">help</span> · <span class="hit-title">list</span> · <span class="hit-title">stats</span> · <span class="hit-title">clear</span> · <span class="hit-title">nexusmem query "…"</span> (or just type a query / pick a chip below)</div>`
    );
  }

  function printList() {
    let html = `<div class="muted">16 recorded prompts — click a number, or its text, to run it:</div>`;
    VITE_BENCH.forEach((e, i) => {
      html += `<div>${i + 1}. <span class="hit-title">${escapeHtml(e.q)}</span> <span class="muted">(${e.source})</span></div>`;
    });
    printLine(html);
  }

  function printStats() {
    const n = VITE_BENCH.length;
    const sumTokens = VITE_BENCH.reduce((s, e) => s + e.tokens, 0);
    const sumFull = VITE_BENCH.reduce((s, e) => s + e.baseFull, 0);
    const sumLog = VITE_BENCH.reduce((s, e) => s + e.baseLog, 0);
    const avgFull = VITE_BENCH.reduce((s, e) => s + e.saveFull, 0) / n;
    const avgLog = VITE_BENCH.reduce((s, e) => s + e.saveLog, 0) / n;
    let html = `<div>aggregate over ${n} recorded prompts, vitejs/vite:</div>`;
    html += `<div class="ps-savings">`;
    html += `<div>packed context &nbsp;${fmt(sumTokens)} tokens total <span class="muted">(${pages(sumTokens)})</span></div>`;
    html += `<div>full files &nbsp;&nbsp;&nbsp;&nbsp;${fmt(sumFull)} tokens <span class="muted">(${pages(sumFull)})</span> &rarr; <span class="save">${pct(1 - sumTokens / sumFull)} saved</span> (avg per-query ${pct(avgFull)})</div>`;
    html += `<div>git log dump ${fmt(sumLog)} tokens <span class="muted">(${pages(sumLog)})</span> &rarr; <span class="save">${pct(1 - sumTokens / sumLog)} saved</span> (avg per-query ${pct(avgLog)})</div>`;
    html += `</div>`;
    html += `<div class="muted ps-plain">so instead of reading ${pages(sumFull)} of full files across all 16, your agent reads ${pages(sumTokens)}.</div>`;
    printLine(html);
  }

  function findMatch(raw) {
    const cleaned = raw.trim();
    // strip a leading `nexusmem query` / `query` and surrounding quotes
    const withoutCmd = cleaned.replace(/^(nexusmem\s+)?query\s+/i, "").trim();
    const unquoted = withoutCmd.replace(/^["'](.*)["']$/, "$1");
    const target = unquoted || cleaned;

    // numeric index into the list
    const asIndex = parseInt(target.replace(/^#/, ""), 10);
    if (!isNaN(asIndex) && asIndex >= 1 && asIndex <= VITE_BENCH.length && /^#?\d+$/.test(target.trim())) {
      return { entry: VITE_BENCH[asIndex - 1], exact: true };
    }

    const targetNorm = norm(target);
    const exact = VITE_BENCH.find((e) => norm(e.q) === targetNorm);
    if (exact) return { entry: exact, exact: true };

    // fuzzy: word-overlap score against the normalized query text
    const targetWords = new Set(targetNorm.split(" ").filter((w) => w.length > 2));
    if (targetWords.size === 0) return null;
    let best = null;
    let bestScore = 0;
    VITE_BENCH.forEach((e) => {
      const words = norm(e.q).split(" ").filter((w) => w.length > 2);
      const overlap = words.filter((w) => targetWords.has(w)).length;
      const score = overlap / Math.max(targetWords.size, words.length);
      if (score > bestScore) {
        bestScore = score;
        best = e;
      }
    });
    if (best && bestScore >= 0.34) return { entry: best, exact: false };
    return null;
  }

  function runEntry(entry, exact) {
    const note = exact
      ? null
      : `nearest recorded prompt: "${escapeHtml(entry.q)}"`;
    const delay = Math.min(entry.ms, 550);
    printLine(`<span class="muted ps-thinking">…</span>`);
    const thinking = output.lastElementChild;
    setTimeout(() => {
      thinking.remove();
      printResult(entry, note);
    }, delay);
  }

  function handleCommand(raw) {
    const cmd = raw.trim();
    printEcho(raw);
    if (!cmd) return;
    const lower = cmd.toLowerCase();

    if (lower === "help" || lower === "?") return printHelp();
    if (lower === "clear" || lower === "cls") {
      output.innerHTML = "";
      return;
    }
    if (lower === "list" || lower === "nexusmem status" || lower === "status") return printList();
    if (lower === "stats" || lower === "nexusmem stats") return printStats();

    const match = findMatch(cmd);
    if (match) {
      runEntry(match.entry, match.exact);
      return;
    }

    printLine(
      `<div class="muted">no recorded prompt matches closely enough. Try <span class="hit-title">list</span> to see all 16, or run it for real against your own repo:<br />` +
        `<code>npx nexusmem init &amp;&amp; npx nexusmem sync &amp;&amp; npx nexusmem query "${escapeHtml(cmd)}"</code></div>`
    );
  }

  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const val = input.value;
    input.value = "";
    handleCommand(val);
  });

  chipRow.innerHTML = VITE_BENCH
    .map((e, i) => `<button type="button" class="ps-chip" data-i="${i}">${escapeHtml(e.q.length > 46 ? e.q.slice(0, 44) + "…" : e.q)}</button>`)
    .join("");

  chipRow.querySelectorAll(".ps-chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      const e = VITE_BENCH[parseInt(btn.getAttribute("data-i"), 10)];
      handleCommand(`nexusmem query "${e.q}"`);
      input.focus();
    });
  });

  printLine(`<div class="muted">Replayed session — real output from a full sync of vitejs/vite (9,567 commits). Type <span class="hit-title">help</span> to start.</div>`);
})();
