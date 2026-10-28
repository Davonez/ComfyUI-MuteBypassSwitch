/**
 * 输出分发开关 (OutputFanoutSwitch) 前端真机验证 —— 新手友好版
 *
 * 只有两个控件：每个输入配几个输出（2/3/4） + 每个输出 开/关
 *
 * 验：
 *   1. 刚拖进来：1 个输入口、2 个输出口（配 2 个）、2 行「开/关」
 *   2. 接上 A -> 输入侧多一个空位，输出还是 2 个
 *   3. out_1/out_2 各接一个 SaveImage -> 两份都是 A
 *   4. 再接上 B -> 输出自动变 4 个，out_3/out_4 跟 B
 *   5. 把「每个输入配几个输出」改成 3 个 -> 输出变 6 个，out_1..3 跟 A
 *   6. 存盘 -> 加载后 口数 / 下拉 / 连线都还在，再排队仍正确
 */

const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const CDP_PORT = 9349;
const COMFY = "http://127.0.0.1:8188";
const USER_DIR = path.join(os.tmpdir(), "ofs-cdp3-" + Date.now());
const APP = `(window.app || (window.comfyAPI && window.comfyAPI.app && window.comfyAPI.app.app))`;

const get = (url) =>
  new Promise((res, rej) =>
    http.get(url, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => res(d)); }).on("error", rej),
  );
const getBuf = (url) =>
  new Promise((res, rej) => {
    http.get(url, (r) => { const chunks = []; r.on("data", (c) => chunks.push(c)); r.on("end", () => res(Buffer.concat(chunks))); })
      .on("error", rej);
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "  [PASS] " : "  [FAIL] "}${name}${detail ? "  — " + detail : ""}`);
};

let edge = null;

async function main() {
  const jsUrl = `${COMFY}/extensions/ComfyUI-MuteBypassSwitch/output_fanout_switch.js`;
  let jsOk = false;
  try { jsOk = (await get(jsUrl)).includes("OutputFanoutSwitch"); } catch (e) {}
  check("前端扩展已被服务器挂出", jsOk, jsUrl);

  fs.mkdirSync(USER_DIR, { recursive: true });
  edge = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${USER_DIR}`,
    "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-gpu",
    "--enable-unsafe-swiftshader", "--window-size=1500,950", COMFY + "/"], { stdio: "ignore" });

  let page = null;
  for (let i = 0; i < 60 && !page; i++) {
    try { const l = JSON.parse(await get(`http://127.0.0.1:${CDP_PORT}/json`)); page = l.find((t) => t.type === "page" && t.url.includes("8188")); } catch (e) {}
    if (!page) await sleep(1000);
  }
  if (!page) throw new Error("拿不到 CDP page target");

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    const cb = pending.get(m.id);
    if (cb) { pending.delete(m.id); cb(m); }
  };
  const send = (method, params = {}) =>
    new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const evalJs = async (expr, awaitPromise = false) => {
    const r = await send("Runtime.evaluate", { expression: expr, awaitPromise, returnByValue: true });
    if (r.result && r.result.exceptionDetails) {
      return { __error: r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text };
    }
    return r.result?.result?.value;
  };

  let boot = null;
  for (let i = 0; i < 90; i++) {
    boot = await evalJs(`(() => {
      const app = ${APP}, lg = window.LiteGraph;
      return { ready: !!(app && app.graph && app.canvas),
               hasOurs: !!(lg && lg.registered_node_types && lg.registered_node_types["OutputFanoutSwitch"]) };
    })()`);
    if (boot && boot.ready && boot.hasOurs) break;
    await sleep(2000);
  }
  console.log("\n[1] 前端就绪:", JSON.stringify(boot));
  if (!boot || !boot.ready) throw new Error("前端没起来");

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

  const built = await evalJs(`(() => {
    const app = ${APP}, g = app.graph;
    g.clear();
    const mk = (t) => { const n = window.LiteGraph.createNode(t); g.add(n); return n; };
    const red = mk("EmptyImage"); red.widgets[0].value = 32; red.widgets[1].value = 32; red.widgets[3].value = 0xFF0000;
    const green = mk("EmptyImage"); green.widgets[0].value = 48; green.widgets[1].value = 48; green.widgets[3].value = 0x00FF00;
    const sw = mk("OutputFanoutSwitch");
    window.__K = { red: red.id, green: green.id, sw: sw.id, saves: [] };
    return { ids: { red: red.id, green: green.id, sw: sw.id } };
  })()`);
  if (built.__error) throw new Error("建图失败: " + built.__error);
  await sleep(700);

  const state = async () => evalJs(`(() => {
    const app = ${APP}, n = app.graph.getNodeById(${built.ids.sw});
    if (!n) return { missing: true };
    const ins = (n.inputs || []).filter(s => !s.widget && /^in_\\d+$/.test(s.name));
    const outs = n.outputs || [];
    const names = (n.widgets || []).map(w => w.name);
    return {
      inputs: ins.map(s => s.name),
      inputsLinked: ins.map(s => s.link != null),
      outputs: outs.map(s => s.name),
      outputsLinked: outs.map(s => (s.links || []).length > 0),
      perInput: (n.widgets || []).find(w => w.name === "每个输入配几个输出")?.value ?? null,
      outWidgets: names.filter(x => /^输出\\d+$/.test(x)),
      allWidgets: names,
    };
  })()`);

  const init = await state();
  console.log("\n[2] 刚建好:", JSON.stringify(init));
  check("控件只有 outputs_per_input + 每个输出一行",
    (init.allWidgets || []).join(",") === "outputs_per_input,output_1,output_2", JSON.stringify(init.allWidgets));
  check("默认 2 个：2 个输出口", (init.outputs || []).join(",") === "out_1,out_2", JSON.stringify(init.outputs));
  check("默认只有 1 个输入口 in_1", (init.inputs || []).join(",") === "in_1", JSON.stringify(init.inputs));
  check("outputs_per_input 默认 2", init.perInput === "2", String(init.perInput));

  const connectIn = async (srcKey, name) => {
    const r = await evalJs(`(() => {
      const app = ${APP}, g = app.graph;
      const src = g.getNodeById(${JSON.stringify(built.ids)}.${srcKey});
      const sw = g.getNodeById(${built.ids.sw});
      const idx = sw.inputs.findIndex(s => s.name === ${JSON.stringify(name)});
      if (idx < 0) return { noSlot: true, have: (sw.inputs || []).map(s => s.name) };
      src.connect(0, sw, idx);
      return { linked: sw.inputs[idx].link != null };
    })()`);
    await sleep(500);
    return r;
  };

  const makeSave = async (prefix) => {
    const r = await evalJs(`(() => {
      const app = ${APP}, g = app.graph;
      const s = window.LiteGraph.createNode("SaveImage"); g.add(s);
      s.pos = [700, 60 + (window.__K.saves || []).length * 200];
      if (s.widgets[0]) s.widgets[0].value = ${JSON.stringify(prefix)};
      window.__K.saves.push(s.id);
      return { id: s.id };
    })()`);
    await sleep(400);
    return r;
  };

  const connectOut = async (outIndex, saveId) => {
    const r = await evalJs(`(() => {
      const app = ${APP}, g = app.graph;
      const sw = g.getNodeById(${built.ids.sw});
      const save = g.getNodeById(${JSON.stringify(saveId)});
      if (!sw.outputs[${outIndex}]) return { noOut: true, outs: (sw.outputs || []).map(s => s.name) };
      sw.connect(${outIndex}, save, 0);
      return { linked: save.inputs[0].link != null };
    })()`);
    await sleep(450);
    return r;
  };

  const c1 = await connectIn("red", "in_1");
  check("A（红 32）接到 in_1", c1.linked === true, JSON.stringify(c1));
  const afterIn1 = await state();
  check("接上 1 路：输入侧多一个空位，输出仍 2 个",
    (afterIn1.inputs || []).join(",") === "in_1,in_2" && (afterIn1.outputs || []).join(",") === "out_1,out_2",
    `${JSON.stringify(afterIn1.inputs)} / ${JSON.stringify(afterIn1.outputs)}`);

  const s1 = await makeSave("ofs3_a1");
  const s2 = await makeSave("ofs3_a2");
  await connectOut(0, s1.id);
  await connectOut(1, s2.id);

  const historyIds = async () => new Set(Object.keys(JSON.parse(await get(`${COMFY}/history`))));
  const queueAndCheck = async (label, expect) => {
    const before = await historyIds();
    const qres = await evalJs(
      `(() => { const app = ${APP}; return app.queuePrompt(0, 1).then(r => JSON.stringify({ ok: r })).catch(e => 'ERR: ' + (e && (e.message || e))); })()`,
      true,
    );
    const qs = String(qres);
    if (qs.startsWith("ERR") || qs.includes('"ok":false')) { check(label, false, `queuePrompt=${qs.slice(0, 200)}`); return; }
    let hist = null;
    for (let i = 0; i < 120 && !hist; i++) {
      await sleep(1000);
      const all = JSON.parse(await get(`${COMFY}/history`));
      const key = Object.keys(all).find((k) => !before.has(k));
      if (key) hist = all[key];
    }
    if (!hist) throw new Error(label + ": 等不到执行结果");
    const status = hist.status || {};
    if (status.status_str !== "success") { check(label, false, JSON.stringify(status.messages || []).slice(0, 300)); return; }
    const details = [];
    let ok = true;
    for (const [saveId, size] of expect) {
      const images = ((hist.outputs || {})[saveId] || {}).images || [];
      if (!images[0]) { ok = false; details.push(`${saveId}: 没产物`); continue; }
      const vq = `filename=${encodeURIComponent(images[0].filename)}&subfolder=${encodeURIComponent(images[0].subfolder || "")}&type=${images[0].type || "output"}`;
      const bytes = await getBuf(`${COMFY}/view?${vq}`);
      const w = bytes.readUInt32BE(16);
      const hgt = bytes.readUInt32BE(20);
      ok = ok && w === size && hgt === size;
      details.push(`${saveId}=${w}x${hgt}` + (w === size && hgt === size ? "" : `(期望${size})`));
    }
    check(label, ok, details.join("; "));
  };

  await queueAndCheck("A 一个输入喂 2 个输出：32 / 32", [[s1.id, 32], [s2.id, 32]]);

  const c2 = await connectIn("green", "in_2");
  check("B（绿 48）接到 in_2", c2.linked === true, JSON.stringify(c2));
  const afterIn2 = await state();
  console.log("\n[3] 接上第 2 路后:", JSON.stringify(afterIn2));
  check("接上第 2 路 -> 输出变 4 个",
    (afterIn2.outputs || []).join(",") === "out_1,out_2,out_3,out_4", JSON.stringify(afterIn2.outputs));
  check("同时多出 output_3 和 output_4 两行",
    (afterIn2.outWidgets || []).join(",") === "output_1,output_2,output_3,output_4", JSON.stringify(afterIn2.outWidgets));

  const s3 = await makeSave("ofs3_b1");
  const s4 = await makeSave("ofs3_b2");
  await connectOut(2, s3.id);
  await connectOut(3, s4.id);
  await queueAndCheck("2 路输入 -> 红红绿绿（32/32/48/48）",
    [[s1.id, 32], [s2.id, 32], [s3.id, 48], [s4.id, 48]]);

  const setPer = await evalJs(`(() => {
    const app = ${APP}, sw = app.graph.getNodeById(${built.ids.sw});
    const w = (sw.widgets || []).find(x => x.name === "outputs_per_input");
    if (!w) return { missing: true };
    w.value = "3";
    if (typeof w.callback === "function") w.callback(w.value);
    return { value: w.value };
  })()`);
  await sleep(800);
  const after3 = await state();
  console.log("\n[4] 改成配 3 个后:", JSON.stringify(after3));
  check("改成配 3 个 -> 输出变 6 个",
    (after3.outputs || []).join(",") === "out_1,out_2,out_3,out_4,out_5,out_6", JSON.stringify(after3.outputs));
  check("下拉也跟着变成 6 行", (after3.outWidgets || []).length === 6, JSON.stringify(after3.outWidgets));

  await queueAndCheck("配 3 个：out_1..3 拿 A(32)、out_4 拿 B(48)",
    [[s1.id, 32], [s2.id, 32], [s3.id, 32], [s4.id, 48]]);

  const reload = await evalJs(`(async () => {
    const app = ${APP}, g = app.graph;
    const data = JSON.parse(JSON.stringify(g.serialize()));
    await app.loadGraphData(data, true, true, "ofs3-roundtrip");
    await new Promise(r => setTimeout(r, 800));
    const sw = app.graph.getNodeById(${built.ids.sw});
    if (!sw) return { missing: true };
    const ins = (sw.inputs || []).filter(s => !s.widget && /^in_\\d+$/.test(s.name));
    return {
      inputs: ins.map(s => s.name),
      inputsLinked: ins.map(s => s.link != null),
      outputs: (sw.outputs || []).map(s => s.name),
      outputsLinked: (sw.outputs || []).map(s => (s.links || []).length > 0),
      perInput: (sw.widgets || []).find(w => w.name === "outputs_per_input")?.value ?? null,
      outWidgets: (sw.widgets || []).map(w => w.name).filter(x => /^输出\\d+$/.test(x)),
    };
  })()`, true);
  console.log("\n[5] 存盘再加载后:", JSON.stringify(reload));
  check("加载后 in_1/in_2 都在且有连线",
    (reload?.inputs || []).slice(0, 2).join(",") === "in_1,in_2" && reload.inputsLinked.slice(0, 2).every(Boolean),
    JSON.stringify(reload?.inputsLinked));
  check("加载后 6 个输出口都在", (reload?.outputs || []).length === 6, JSON.stringify(reload?.outputs));
  check("加载后 4 个 SaveImage 的连线都还原了",
    (reload?.outputsLinked || []).slice(0, 4).every(Boolean), JSON.stringify(reload?.outputsLinked));
  check("加载后 outputs_per_input 还是 3", reload?.perInput === "3", String(reload?.perInput));

  await queueAndCheck("加载后再跑一次仍然正确（32/32/32/48）",
    [[s1.id, 32], [s2.id, 32], [s3.id, 32], [s4.id, 48]]);

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
