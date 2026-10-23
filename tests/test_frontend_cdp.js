/**
 * 前端真机验证（headless Edge + CDP）：
 *   1. 通配符 "*" 的插槽，在画布上到底能不能双向拖线（源→开关、开关→下游）；
 *   2. 把主线上游节点设成「静音」(mode=2) 后，真实前端 graphToPrompt() 出来的 prompt
 *      里 main 这根线是否真的消失（复现故障条件）；
 *   3. 在这种状态下真的点「排队」，看任务是否还能跑成功（旁路是否接管）；
 *   4. 取消静音后 main 是否回到 prompt（确认平时行为没被改变）。
 *
 * 用法: node test_frontend_cdp.js
 */

const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const CDP_PORT = 9333;
const COMFY = "http://127.0.0.1:8188";
const USER_DIR = path.join(os.tmpdir(), "mbs-cdp-" + Date.now());

// 新版前端的 app 不一定挂在 window 上，两个位置都试
const APP = `(window.app || (window.comfyAPI && window.comfyAPI.app && window.comfyAPI.app.app))`;

const get = (url) =>
  new Promise((res, rej) =>
    http
      .get(url, (r) => {
        let d = "";
        r.on("data", (c) => (d += c));
        r.on("end", () => res(d));
      })
      .on("error", rej),
  );
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "  [PASS] " : "  [FAIL] "}${name}${detail ? "  — " + detail : ""}`);
};

let edge = null;

async function main() {
  fs.mkdirSync(USER_DIR, { recursive: true });
  edge = spawn(
    EDGE,
    [
      "--headless=new",
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${USER_DIR}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-gpu",
      "--enable-unsafe-swiftshader",
      "--window-size=1500,950",
      COMFY + "/",
    ],
    { stdio: "ignore", detached: false },
  );

  // --- 1. 找 page target
  let page = null;
  for (let i = 0; i < 60 && !page; i++) {
    try {
      const list = JSON.parse(await get(`http://127.0.0.1:${CDP_PORT}/json`));
      page = list.find((t) => t.type === "page" && t.url.includes("8188"));
    } catch (e) {}
    if (!page) await sleep(1000);
  }
  if (!page) throw new Error("拿不到 CDP page target");
  console.log("page:", page.url);

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    const cb = pending.get(m.id);
    if (cb) {
      pending.delete(m.id);
      cb(m);
    }
  };
  const send = (method, params = {}) =>
    new Promise((res) => {
      const i = ++id;
      pending.set(i, res);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  const evalJs = async (expr, awaitPromise = false) => {
    const r = await send("Runtime.evaluate", {
      expression: expr,
      awaitPromise,
      returnByValue: true,
    });
    if (r.result && r.result.exceptionDetails) {
      const d = r.result.exceptionDetails;
      return { __error: (d.exception && (d.exception.description || d.exception.value)) || d.text };
    }
    return r.result && r.result.result ? r.result.result.value : undefined;
  };

  // --- 2. 等前端真正启动（app + canvas 都就绪）+ 我们的节点注册
  let boot = null;
  for (let i = 0; i < 90; i++) {
    boot = await evalJs(`(() => {
      const app = ${APP};
      const lg = window.LiteGraph || null;
      const map = lg && lg.registered_node_types;
      return {
        ready: !!(app && app.graph && app.canvas),
        types: map ? Object.keys(map).length : -1,
        hasOurs: !!(map && map["MuteBypassSwitch"]),
      };
    })()`);
    if (boot && boot.ready && boot.hasOurs) break;
    if (i % 10 === 0) console.log("  waiting frontend:", JSON.stringify(boot));
    await sleep(2000);
  }
  console.log("\n[1] 前端/节点注册:", JSON.stringify(boot));
  if (!boot || !boot.ready) throw new Error("前端没起来");

  // 前端起来后还会异步把「上次工作流 / 默认模板」灌进画布，会半路把我们的图换掉。
  // 等画布节点数稳定 + 至少 10 秒，再动它。
  const t0 = Date.now();
  let stable = 0;
  let prev = -1;
  while (stable < 5) {
    const c = await evalJs(`(() => { const app = ${APP}; return app && app.graph ? app.graph._nodes.length : -1; })()`);
    stable = c === prev && c >= 0 ? stable + 1 : 0;
    prev = c;
    await sleep(700);
    if (Date.now() - t0 > 30000) break;
  }
  await sleep(Math.max(0, 10000 - (Date.now() - t0)));
  console.log("  画布稳定 (节点数 %d)", prev);

  // --- 3. 在画布上搭链路并连线（两个方向都试）
  const build = await evalJs(`(() => {
    const app = ${APP};
    const g = app.graph;
    g.clear();
    const mk = (t) => { const n = window.LiteGraph.createNode(t); g.add(n); return n; };
    const srcMain = mk("EmptyImage");
    const srcBypass = mk("EmptyImage");
    const sw = mk("MuteBypassSwitch");
    const save = mk("SaveImage");
    // EmptyImage 的控件: width, height, batch_size, color
    srcMain.widgets[0].value = 128; srcMain.widgets[1].value = 128;
    srcBypass.widgets[0].value = 64; srcBypass.widgets[1].value = 64;
    srcMain.widgets[3].value = 255;        // 蓝
    srcBypass.widgets[3].value = 16711680; // 红
    if (save.widgets[0]) save.widgets[0].value = "mbs_ui_test";

    const slot = (n, name, kind) => (kind === "in" ? n.inputs : n.outputs).findIndex(s => s.name === name);
    const nMain = slot(sw, "main", "in"), nBy = slot(sw, "bypass", "in");
    const nImg = slot(save, "images", "in"), nData = slot(sw, "data", "out");

    // 源(具体类型 IMAGE) -> 开关的通配输入
    const e1 = srcMain.connect(0, sw, nMain);
    const e2 = srcBypass.connect(0, sw, nBy);
    // 开关的通配输出 -> 下游的具体类型输入
    const e3 = sw.connect(nData, save, nImg);

    const wSwitch = (sw.widgets || []).find(w => w.name === "switch");
    const wRoute = (sw.widgets || []).find(w => w.name === "route");
    if (wSwitch) wSwitch.value = true;
    if (wRoute) wRoute.value = "auto";

    return {
      ids: { srcMain: srcMain.id, srcBypass: srcBypass.id, sw: sw.id, save: save.id },
      slotIdx: { nMain, nBy, nImg, nData },
      connectErrors: { e1: e1 || null, e2: e2 || null, e3: e3 || null },
      linked: {
        main: sw.inputs[nMain].link !== null,
        bypass: sw.inputs[nBy].link !== null,
        out: save.inputs[nImg].link !== null,
      },
      widgets: (sw.widgets || []).map(w => ({ name: w.name, value: w.value })),
      inputs: (sw.inputs || []).map(s => ({ name: s.name, type: s.type })),
      outputs: (sw.outputs || []).map(s => ({ name: s.name, type: s.type })),
    };
  })()`);
  console.log("\n[2] 画布连线结果:", JSON.stringify(build, null, 1));
  if (build.__error) throw new Error("建图失败: " + build.__error);

  check("源(IMAGE) -> 开关 main 连线成功", build.linked.main === true, JSON.stringify(build.connectErrors.e1));
  check("源(IMAGE) -> 开关 bypass 连线成功", build.linked.bypass === true, JSON.stringify(build.connectErrors.e2));
  check("开关 data(*) -> SaveImage images 连线成功", build.linked.out === true, JSON.stringify(build.connectErrors.e3));
  check("两个控件都在 (switch / route)",
    (build.widgets || []).map(w => w.name).join(",") === "switch,route",
    JSON.stringify(build.widgets));

  const swKey = String(build.ids.sw);

  // --- 4. 未静音时的 prompt
  const raw0 = await evalJs(
    `(() => { const app = ${APP}; return app.graphToPrompt().then(p => JSON.stringify(p.output)).catch(e => 'ERR: ' + e); })()`, true);
  let p0 = null;
  try { p0 = JSON.parse(raw0); } catch (e) {}
  console.log("\n[3] 静音前 prompt 里的开关节点:", JSON.stringify(p0 && p0[swKey]));

  // --- 5. 静音主线上游（mode = 2，等价于画布上 Ctrl+M）
  const muted = await evalJs(`(() => {
    const app = ${APP};
    const n = app.graph.getNodeById(${build.ids.srcMain});
    if (!n) return { missing: true, ids: app.graph._nodes.map(x => x.id) };
    n.mode = 2;
    return { mode: n.mode };
  })()`);
  console.log("\n[4] 把主线上游静音:", JSON.stringify(muted));
  if (muted.missing) throw new Error("画布被前端换掉了（模板异步加载），重跑一次即可: " + JSON.stringify(muted.ids));

  const raw1 = await evalJs(
    `(() => { const app = ${APP}; return app.graphToPrompt().then(p => JSON.stringify(p.output)).catch(e => 'ERR: ' + e); })()`, true);
  let p1 = null;
  try { p1 = JSON.parse(raw1); } catch (e) {}
  const swAfter = p1 && p1[swKey];
  console.log("[5] 静音后 prompt 里的开关节点:", JSON.stringify(swAfter));
  check("静音后 main 这根线从 prompt 里消失（故障条件复现）",
    !!swAfter && !("main" in swAfter.inputs),
    JSON.stringify(swAfter && swAfter.inputs));
  check("静音后 bypass 仍在 prompt 里",
    !!swAfter && Array.isArray(swAfter.inputs.bypass),
    JSON.stringify(swAfter && swAfter.inputs.bypass));
  check("被静音的上游节点自己不在 prompt 里",
    !!p1 && !(String(build.ids.srcMain) in p1));

  // --- 6. 这种状态下真的排队（app.queuePrompt 不返回 prompt_id，用 history 增量抓）
  const historyIds = async () => new Set(Object.keys(JSON.parse(await get(`${COMFY}/history`))));
  const before = await historyIds();
  const queued = await evalJs(
    `(() => { const app = ${APP}; return app.queuePrompt(0, 1).then(() => 'queued').catch(e => 'ERR: ' + e); })()`, true);
  console.log("\n[6] queuePrompt:", JSON.stringify(queued));

  let pid = null;
  let hist = null;
  for (let i = 0; i < 120; i++) {
    await sleep(1000);
    try {
      const all = JSON.parse(await get(`${COMFY}/history`));
      pid = Object.keys(all).find((k) => !before.has(k));
      if (pid) { hist = all[pid]; break; }
    } catch (e) {}
  }
  if (!hist) throw new Error("等不到执行结果");
  const status = hist.status || {};
  const outs = hist.outputs || {};
  const imgs = Object.values(outs).flatMap((o) => o.images || []);
  console.log("[7] 执行状态:", status.status_str, "| 产物:", imgs.map((i) => i.filename).join(", "));
  check("静音状态下任务执行成功（旁路接管）", status.status_str === "success",
    JSON.stringify(status.messages || []).slice(0, 400));
  check("确实产出了图片", imgs.length > 0, imgs.map((i) => i.filename).join(","));

  // 用 PNG 的 IHDR 尺寸判断走的是哪一路：主线是蓝 128x128，旁路是红 64x64
  if (imgs[0]) {
    const q = `filename=${encodeURIComponent(imgs[0].filename)}&subfolder=${encodeURIComponent(imgs[0].subfolder || "")}&type=${imgs[0].type || "output"}`;
    const bytes = await new Promise((res, rej) => {
      http.get(`${COMFY}/view?${q}`, (r) => {
        const chunks = [];
        r.on("data", (c) => chunks.push(c));
        r.on("end", () => res(Buffer.concat(chunks)));
      }).on("error", rej);
    });
    if (bytes.slice(1, 4).toString() === "PNG") {
      const w = bytes.readUInt32BE(16), hh = bytes.readUInt32BE(20);
      check("产物尺寸 = 旁路那一路 (64x64)，不是主线 (128x128)",
        w === 64 && hh === 64, `${w}x${hh}`);
    } else {
      check("产物是 PNG", false, bytes.slice(0, 8).toString("hex"));
    }
    fs.writeFileSync(path.join(os.tmpdir(), "mbs_ui_last.json"), JSON.stringify(imgs[0]));
  }

  // --- 7. 取消静音，确认 main 回到 prompt
  const restored = await evalJs(`(() => {
    const app = ${APP};
    const n = app.graph.getNodeById(${build.ids.srcMain});
    if (!n) return { missing: true };
    n.mode = 0;
    return { mode: n.mode };
  })()`);
  if (restored.missing) throw new Error("画布被前端换掉了（模板异步加载），重跑一次即可");
  const raw2 = await evalJs(
    `(() => { const app = ${APP}; return app.graphToPrompt().then(p => JSON.stringify(p.output)).catch(e => 'ERR: ' + e); })()`, true);
  let p2 = null;
  try { p2 = JSON.parse(raw2); } catch (e) {}
  check("取消静音后 main 重新出现在 prompt 里",
    !!(p2 && p2[swKey] && Array.isArray(p2[swKey].inputs.main)),
    JSON.stringify(p2 && p2[swKey] && p2[swKey].inputs));

  ws.close();
}

main().then(
  () => {
    const fail = checks.filter((c) => !c.ok).length;
    console.log(`\n${checks.length - fail}/${checks.length} 通过`);
    try { edge && edge.kill(); } catch (e) {}
    process.exit(fail ? 1 : 0);
  },
  (e) => {
    console.error("FAILED:", e && e.stack ? e.stack : e);
    try { edge && edge.kill(); } catch (err) {}
    process.exit(1);
  },
);
