/* Fold Metric workbench — reads data/manifest.json, data/status.json, data/tasks/<id>.json */

const DATA_ROOT = "data/";
const GRID_COLS = 7;
const GRID_ROWS = 8;
const GRID_CELLS = GRID_COLS * GRID_ROWS; // 56 slots for 50 samples
const POLL_MS = 0;

const state = {
  manifest: null,
  status: null,
  activeModels: new Set(),
  cache: new Map(),
  current: null,
  seen: new Map(),      // "task|model|metric" -> Set(sample_id) already rendered
  polling: null,
};

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

function rankClass(rank) {
  if (rank <= 1) return "r1";
  if (rank <= 5) return "r5";
  if (rank <= 10) return "r10";
  return "rbad";
}

function fmtNum(v) {
  if (v === null || v === undefined) return "–";
  return Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(3);
}

async function getJSON(path, optional = false) {
  try {
    const res = await fetch(`${path}${path.includes("?") ? "&" : "?"}_=${Date.now()}`,
                            { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    if (optional) return null;
    throw new Error(`${path}: ${err.message}`);
  }
}

/* ------------------------------- boot ------------------------------- */

async function boot() {
  try {
    state.manifest = await getJSON(DATA_ROOT + "manifest.json");
  } catch (err) {
    showError(err);
    return;
  }
  state.manifest.models.forEach((x) => state.activeModels.add(x.id));
  state.status = await getJSON(DATA_ROOT + "status.json", true);

  if (state.manifest.mock) $("#mock-badge").classList.remove("hidden");
  $("#summary-note").textContent =
    `${state.manifest.n_tasks} 组 · ${state.manifest.models.length} 个模型 · ${state.manifest.metrics.length} 个指标`;

  renderChips();
  renderGpus();
  renderSummary();
  renderTasks();
  window.addEventListener("hashchange", route);
  await route();
  startPolling();
}

function showError(err) {
  const box = $("#error");
  box.classList.remove("hidden");
  box.innerHTML =
    `<b>无法读取数据</b>：${err.message}<br>` +
    `如果用 file:// 直接打开，浏览器会拦截 fetch。请在 <code>workbench/</code> 下起静态服务：` +
    `<code>python3 -m http.server 8000</code>，再访问 <code>http://127.0.0.1:8000/</code>。`;
}

/* ------------------------------ polling ----------------------------- */

function startPolling() {
  if (!POLL_MS) return;
  if (state.polling) clearInterval(state.polling);
  state.polling = setInterval(tick, POLL_MS);
}

async function tick() {
  const status = await getJSON(DATA_ROOT + "status.json", true);
  if (status) {
    state.status = status;
    renderGpus();
    renderLiveBadge();
  }
  const manifest = await getJSON(DATA_ROOT + "manifest.json", true);
  if (manifest) {
    state.manifest = manifest;
    renderSummary();
    renderTasks();
  }
  if (state.current) {
    const fresh = await getJSON(`${DATA_ROOT}tasks/${state.current.task_id}.json`, true);
    if (fresh) {
      state.cache.set(fresh.task_id, fresh);
      const prev = state.current.progress ? state.current.progress.predicted : -1;
      const now = fresh.progress ? fresh.progress.predicted : -1;
      state.current = fresh;
      if (now !== prev) renderDetail(fresh);
      else renderProgressOnly(fresh);
    }
  }
}

/* ------------------------------ gpus -------------------------------- */

function renderGpus() {
  const strip = $("#gpu-strip");
  const wrap = strip.closest(".gpu-wrap");
  const s = state.status;
  if (!s || !s.gpus) {
    strip.classList.add("hidden");
    if (wrap) wrap.classList.add("hidden");
    return;
  }
  strip.classList.remove("hidden");
  if (wrap) wrap.classList.remove("hidden");
  strip.innerHTML = "";
  s.gpus.forEach((g) => {
    const card = el("div", `gpu ${g.state === "running" ? "running" : "idle"}`);
    const head = el("div", "gpu-head");
    head.appendChild(el("span", "gpu-idx", `GPU ${g.index}`));
    head.appendChild(el("span", `gpu-state ${g.state}`, g.state === "running" ? "运行中" : "空闲"));
    card.appendChild(head);

    const name = el("div", "gpu-name", g.name || `GPU ${g.index}`);
    card.appendChild(name);

    const job = el("div", "gpu-job");
    if (g.state === "running") {
      job.appendChild(el("span", "tag", g.task_id || "–"));
      job.appendChild(el("span", "muted", g.model || ""));
      job.appendChild(el("span", "gpu-sample", g.sample_id || ""));
    } else {
      job.appendChild(el("span", "muted", "等待任务"));
    }
    card.appendChild(job);

    card.appendChild(bar("利用率", g.util || 0, 100, `${g.util || 0}%`));
    const memPct = g.mem_total ? ((g.mem_used / g.mem_total) * 100) : 0;
    card.appendChild(bar("显存", memPct, 100,
      g.mem_total ? `${g.mem_used.toFixed(1)}/${g.mem_total.toFixed(0)} GB` : "–"));
    strip.appendChild(card);
  });

  const t = s.totals || {};
  let head = "";
  if (t.per_model) {
    const names = {};
    (state.manifest.models || []).forEach((m) => { names[m.id] = m.name; });
    head = Object.entries(t.per_model)
      .filter(([, v]) => v.predicted > 0)
      .map(([mid, v]) => `${names[mid] || mid} ${v.predicted >= v.total ? "\u2713 " : ""}${v.predicted}/${v.total}`)
      .join(" · ");
  } else if (t.total_samples) {
    head = `${t.predicted_samples}/${t.total_samples} 条`;
  }
  $("#gpu-totals").textContent = head + (t.finished ? " · 全部完成" : "");
}

function bar(label, value, max, text) {
  const wrap = el("div", "gpu-bar");
  const head = el("div", "gpu-bar-head");
  head.appendChild(el("span", "muted", label));
  head.appendChild(el("span", "gpu-bar-val", text));
  wrap.appendChild(head);
  const track = el("div", "track");
  const fill = el("i");
  fill.style.width = `${Math.max(0, Math.min(100, (value / max) * 100))}%`;
  track.appendChild(fill);
  wrap.appendChild(track);
  return wrap;
}

function renderLiveBadge() {
  const s = state.status;
  const badge = $("#live-badge");
  if (!s) { badge.classList.add("hidden"); return; }
  badge.classList.remove("hidden", "stale");
  const age = (Date.now() - new Date(s.generated_at).getTime()) / 1000;
  if (age > 30) {
    badge.classList.add("stale");
    badge.textContent = `离线 · ${Math.round(age)}s 前`;
  } else {
    badge.textContent = "LIVE";
  }
}

/* ------------------------------ filters ----------------------------- */

function renderChips() {
  const box = $("#model-chips");
  box.innerHTML = "";
  state.manifest.models.forEach((m) => {
    const b = el("button", "chip on", m.name);
    b.onclick = () => {
      if (state.activeModels.has(m.id)) {
        if (state.activeModels.size === 1) return;
        state.activeModels.delete(m.id);
        b.classList.remove("on");
        b.classList.add("off");
      } else {
        state.activeModels.add(m.id);
        b.classList.add("on");
        b.classList.remove("off");
      }
      renderSummary();
      renderTasks();
      if (state.current) renderDetail(state.current);
    };
    box.appendChild(b);
  });
}

/* ----------------------------- summary ------------------------------ */

function renderSummary() {
  // One block per model: these metrics are NOT comparable across models, so they are never
  // placed side by side in one table.
  const { models, metrics, summary } = state.manifest;
  const active = models.filter((m) => state.activeModels.has(m.id));
  const box = $("#summary-blocks");
  box.innerHTML = "";

  active.forEach((m) => {
    const per = summary[m.id] || {};
    const nGroups = Object.values(per).reduce((acc, s) => Math.max(acc, (s && s.n_tasks) || 0), 0);
    const card = el("div", "model-summary");
    const head = el("div", "model-summary-head");
    head.appendChild(el("h3", "", m.name));
    head.appendChild(el("span", "muted",
      nGroups ? `${nGroups} 组有结果 · 仅在本模型内排序` : "尚无结果"));
    card.appendChild(head);

    const table = el("table");
    const thead = el("thead");
    const hr = el("tr");
    ["指标", "Top1", "Top5", "Top10", "失败", "平均名次"].forEach((h) =>
      hr.appendChild(el("th", "", h)));
    thead.appendChild(hr);
    table.appendChild(thead);

    const tbody = el("tbody");
    metrics.forEach((mt) => {
      const s = per[mt.id];
      const tr = el("tr");
      tr.appendChild(el("td", "", mt.name + (mt.higher ? "" : " ↓")));
      if (!s) {
        for (let i = 0; i < 5; i++) tr.appendChild(el("td", "num", "–"));
      } else {
        tr.appendChild(el("td", "num", String(s.top1)));
        tr.appendChild(el("td", "num", String(s.top5)));
        const td = el("td", "num");
        const ratio = s.top10 / Math.max(1, s.n_tasks);
        const cls = ratio >= 0.8 ? "r1" : ratio >= 0.5 ? "r5" : ratio >= 0.2 ? "r10" : "rbad";
        td.appendChild(el("span", `rank-pill ${cls}`, `${s.top10}/${s.n_tasks}`));
        tr.appendChild(td);
        tr.appendChild(el("td", "num", s.n_failed ? String(s.n_failed) : "–"));
        tr.appendChild(el("td", "num",
          s.mean_rank === null || s.mean_rank === undefined ? "–" : String(s.mean_rank)));
        tr.title = `${mt.name}: 可排名 ${s.n_rankable === undefined ? s.n_tasks : s.n_rankable} 组` +
          (s.n_failed ? `，失败 ${s.n_failed} 组（ipSAE=0）` : "");
      }
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    card.appendChild(table);
    box.appendChild(card);
  });
}

/* ------------------------------ tasks ------------------------------- */

function taskProgress(t) {
  if (!state.status || !state.status.gpus) return null;
  const g = state.status.gpus.find((x) => x.task_id === t.id);
  return g ? g : null;
}

function renderTasks() {
  const grid = $("#task-grid");
  grid.innerHTML = "";
  state.manifest.tasks.forEach((t) => {
    const running = taskProgress(t);
    const card = el("div", `task${running ? " is-running" : ""}`);
    card.tabIndex = 0;
    card.setAttribute("role", "button");

    const top = el("div", "task-top");
    top.appendChild(el("span", "task-id", t.id));
    const right = el("span", "task-len", `抗原 ${t.antigen_len} aa`);
    top.appendChild(right);
    card.appendChild(top);
    card.appendChild(el("div", "task-name", t.antigen || "（未命名抗原）"));
    const pm = t.per_model || {};
    const activeIds = state.manifest.models
      .filter((m) => state.activeModels.has(m.id))
      .map((m) => m.id);
    // the bar follows the model that is running; if nothing runs, the furthest one wins
    const runningId = activeIds.find((id) => (pm[id] || {}).status === "running");
    const barId = runningId || activeIds.slice().sort(
      (a, b) => ((pm[b] || {}).predicted || 0) - ((pm[a] || {}).predicted || 0))[0];
    const barInfo = barId ? (pm[barId] || { predicted: t.predicted || 0, total: t.n_samples }) : null;
    if (barInfo) {
      const total = barInfo.total || t.n_samples;
      const pred = barInfo.predicted || 0;
      const isDone = pred >= total;
      const mName = (state.manifest.models.find((m) => m.id === barId) || {}).name || "";
      const pbar = el("div", `task-progress${isDone ? " done" : ""}`);
      const track = el("div", "track");
      const fill = el("i");
      fill.style.width = `${(pred / total) * 100}%`;
      track.appendChild(fill);
      pbar.appendChild(track);
      pbar.appendChild(el("span", "txt", isDone
        ? `\u2713 ${mName} ${total}/${total}`
        : `${mName} ${pred}/${total}`));
      card.appendChild(pbar);
      if (isDone) card.classList.add("is-done");
    }

    if (running) {
      const r = el("div", "task-running");
      r.appendChild(el("span", "pulse-dot"));
      r.appendChild(el("span", "", `GPU ${running.index} · ${running.model || ""} · ${running.sample_id || ""}`));
      card.appendChild(r);
    }

    const ranks = el("div", "task-ranks");
    state.manifest.models
      .filter((m) => state.activeModels.has(m.id))
      .forEach((m) => {
        const info = pm[m.id] || { predicted: 0, total: t.n_samples, status: "pending" };
        const st = info.status || "pending";
        const r = (t.best_rank || {})[m.id];
        ranks.appendChild(el("span", "rk-name", m.name));
        let label;
        let cls;
        if (st === "finish") {
          label = r === null || r === undefined ? "Finish" : `Finish #${r}`;
          cls = "st-finish";
        } else if (st === "running") {
          label = `Running ${info.predicted}/${info.total}`;
          cls = "st-running";
        } else {
          label = "Pending";
          cls = "st-pending";
        }
        const pill = el("b", `st ${cls}`, label);
        if (st === "running") pill.appendChild(el("span", "pulse-dot"));
        ranks.appendChild(pill);
      });
    card.appendChild(ranks);

    card.onclick = () => { location.hash = `#${t.id}`; };
    card.onkeydown = (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); location.hash = `#${t.id}`; }
    };
    grid.appendChild(card);
  });
}

/* ------------------------------ detail ------------------------------ */

async function route() {
  const id = decodeURIComponent(location.hash.replace(/^#/, ""));
  if (!id) {
    state.current = null;
    $("#overview").classList.remove("hidden");
    $("#detail").classList.add("hidden");
    return;
  }
  let task = state.cache.get(id);
  if (!task) {
    try {
      task = await getJSON(`${DATA_ROOT}tasks/${id}.json`);
      state.cache.set(id, task);
    } catch (err) {
      showError(err);
      return;
    }
  }
  state.current = task;
  $("#overview").classList.add("hidden");
  $("#detail").classList.remove("hidden");
  $("#detail-title").textContent = `${task.task_id} · ${task.antigen_name || ""}`;
  renderDetail(task);
  window.scrollTo({ top: 0, behavior: "instant" });
}

function renderProgressOnly(task) {
  const bar = $("#detail-progress");
  if (!bar || !task.progress) return;
  const prog = task.progress;
  bar.classList.toggle("done", !!prog.complete);
  bar.querySelector(".fill").style.width = `${(prog.predicted / prog.total) * 100}%`;
  bar.querySelector(".txt").textContent = prog.complete
    ? `\u2713 已完成 ${prog.total} / ${prog.total}`
    : `${prog.predicted} / ${prog.total} 条已预测`;
}

function renderDetail(task) {
  const body = $("#detail-body");
  body.innerHTML = "";
  const { metrics, models } = state.manifest;
  const labels = new Map(task.samples.map((s) => [s.id, s.label]));
  const prog = task.progress || { predicted: task.samples.length, total: task.samples.length, complete: true };

  $("#detail-sub").textContent =
    `抗原 ${task.antigen_len} aa · 共 ${task.samples.length} 条样本（1 正 + ${task.samples.length - 1} 负）` +
    (prog.complete ? "" : ` · 进行中，已预测 ${prog.predicted} 条（名次为暂列）`);

  const pbar = el("div", `progress${prog.complete ? " done" : ""}`);
  pbar.id = "detail-progress";
  const track = el("div", "track");
  const fill = el("i", "fill");
  fill.style.width = `${(prog.predicted / prog.total) * 100}%`;
  track.appendChild(fill);
  pbar.appendChild(track);
  pbar.appendChild(el("span", "txt", prog.complete
    ? `\u2713 已完成 ${prog.total} / ${prog.total}`
    : `${prog.predicted} / ${prog.total} 条已预测`));
  body.appendChild(pbar);

  models.filter((m) => state.activeModels.has(m.id)).forEach((m) => {
    const modelData = task.models[m.id];
    if (!modelData || !Object.keys(modelData).length) {
      const pi = ((task.progress || {}).per_model || {})[m.id] || { status: "pending", predicted: 0, total: task.samples.length };
      const blk = el("div", "model-block model-pending");
      const hd = el("div", "model-head");
      hd.appendChild(el("h3", "", m.name));
      hd.appendChild(el("span", `st ${pi.status === "running" ? "st-running" : "st-pending"}`,
        pi.status === "running" ? `Running ${pi.predicted}/${pi.total}` : "Pending"));
      blk.appendChild(hd);
      blk.appendChild(el("div", "metric-wait", "该模型尚未开始（无预测结果）"));
      body.appendChild(blk);
      return;
    }

    const block = el("div", "model-block");
    const head = el("div", "model-head");
    head.appendChild(el("h3", "", m.name));

    const hits = el("div", "hits");
    const ranks = metrics.map((mt) => (modelData[mt.id] ? modelData[mt.id].positive_rank : null))
                          .filter((r) => r !== null);
    [["Top1", 1], ["Top5", 5], ["Top10", 10]].forEach(([label, k]) => {
      const c = ranks.filter((r) => r <= k).length;
      const cls = ranks.length && c === ranks.length ? "r1" : c > 0 ? "r10" : "rbad";
      hits.appendChild(el("span", `rank-pill ${cls}`, `${label} ${c}/${ranks.length}`));
    });
    head.appendChild(hits);
    block.appendChild(head);

    const grid = el("div", "metric-grid");
    metrics.forEach((mt) => {
      const d = modelData[mt.id];
      if (!d) {
        const empty = el("div", "metric metric-empty");
        empty.appendChild(el("div", "metric-name", mt.name));
        empty.appendChild(el("div", "metric-wait", "尚无数据"));
        grid.appendChild(empty);
        return;
      }
      grid.appendChild(renderMetric(task, mt, d, labels));
    });
    block.appendChild(grid);
    body.appendChild(block);
  });
}

function renderMetric(task, metric, d, labels) {
  const key = `${task.task_id}|${metric.id}`;
  const seen = state.seen.get(key) || new Set();
  const total = task.samples.length;

  const card = el("div", "metric");
  const head = el("div", "metric-head");
  const name = el("div", "metric-name", metric.name);
  if (!metric.higher) name.appendChild(el("small", "", "越低越好"));
  head.appendChild(name);

  const done = d.order.length;
  const rank = d.positive_rank;
  const isIpSae = metric.id.indexOf("ipsae") === 0;
  if (d.failed === true) {
    head.appendChild(el("span", "metric-rank rank-pill rfail", "失败（ipSAE=0）"));
  } else if (rank === null || rank === undefined) {
    head.appendChild(el("span", "metric-rank rank-pill rwait", d.partial ? "正样本未预测" : "–"));
  } else {
    head.appendChild(el("span", `metric-rank rank-pill ${rankClass(rank)}${d.partial ? " partial" : ""}`,
                        d.partial ? `暂列 ${rank} / ${done}` : `第 ${rank} / ${done}`));
  }
  card.appendChild(head);

  const cells = el("div", "cells");
  for (let i = 0; i < GRID_CELLS; i++) {
    if (i < d.order.length) {
      const sid = d.order[i];
      const val = d.values[i];
      const isPos = labels.get(sid) === 1;
      const zeroVal = isIpSae && val === 0;
      const c = el("div", `cell ${isPos ? "pos" : ""}${zeroVal ? " zero" : ""}${seen.has(sid) ? "" : " new"}`);
      c.title = `${sid} · ${metric.name} = ${fmtNum(val)}${metric.unit ? " " + metric.unit : ""}` +
        (zeroVal ? " · 精确 0（无界面），不可排名" : ` · 第 ${i + 1} 位`);
      if (isPos) c.appendChild(el("span", "", zeroVal ? "–" : String(i + 1)));
      cells.appendChild(c);
    } else if (i < total) {
      const c = el("div", "cell pending");
      c.title = "尚未预测";
      cells.appendChild(c);
    } else {
      const c = el("div", "cell empty");
      c.title = "空位";
      cells.appendChild(c);
    }
  }
  state.seen.set(key, new Set(d.order));
  card.appendChild(cells);

  const posIdx = d.order.findIndex((sid) => labels.get(sid) === 1);
  const bestNegIdx = d.order.findIndex((sid) => labels.get(sid) !== 1);
  const unit = metric.unit ? " " + metric.unit : "";
  const foot = el("div", "metric-foot");
  foot.appendChild(el("span", "", posIdx >= 0 ? `正样本 ${fmtNum(d.values[posIdx])}${unit}` : "正样本 –"));
  foot.appendChild(el("span", "", bestNegIdx >= 0
    ? `最佳负样本 ${fmtNum(d.values[bestNegIdx])}${unit}` : "最佳负样本 –"));
  card.appendChild(foot);
  return card;
}

/* ------------------------------ wire up ----------------------------- */

$("#back").onclick = () => { location.hash = ""; };

boot();
