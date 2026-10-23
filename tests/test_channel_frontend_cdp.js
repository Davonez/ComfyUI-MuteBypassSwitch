/**
 * 多通道汇聚开关 (MultiChannelSwitch) 前端真机验证 —— headless Edge + CDP
 *
 * 验的是"输入侧和输出侧都能自动加路"：
 *   1. 刚拖进画布：只有 1 个通道 = 2 个输入口 + 1 个输出口（后端声明了 8 个输出，其余收起来）；
 *   2. 通道 1 的 a、b 都接上 -> 自动长出通道 2（+2 输入 / +1 输出）；
 *   3. 通道 2 也接满 -> 长出通道 3；
 *   4. 把通道 1 的 a 静音后再排队：ch1 走 b(48x48 绿)、ch2 走 a(64x64 蓝)，互不影响；
 *   5. 存盘 -> 加载后通道数、输出数、连线都还在；
 *   6. 右键「加一个通道 / 删掉最后一个空通道」也能用。
 *
 * 用法: node test_channel_frontend_cdp.js
 */

const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const CDP_PORT = 9340;
const COMFY = "http://127.0.0.1:8188";
const USER_DIR = path.join(os.tmpdir(), "mcs-cdp-" + Date.now());
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
const getBuf = (url) =>
  new Promise((res, rej) => {
    http
      .get(url, (r) => {
        const chunks = [];
        r.on("data", (c) => chunks.push(c));
        r.on("end", () => res(Buffer.concat(chunks)));
      })
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
  const jsUrl = `${COMFY}/extensions/ComfyUI-MuteBypassSwitch/multi_channel_switch.js`;
  let jsOk = false;
  try {
    jsOk = (await get(jsUrl)).includes("MultiChannelSwitch");
  } catch (e) {}
  check("前端扩展已被服务器挂出", jsOk, jsUrl);

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
    { stdio: "ignore" },
  );

  let page = null;
  for (let i = 0; i < 60 && !page; i++) {
    try {
      const list = JSON.parse(await get(`http://127.0.0.1:${CDP_PORT}/json`));
      page = list.find((t) => t.type === "page" && t.url.includes("8188"));
    } catch (e) {}
    if (!page) await sleep(1000);
  }
  if (!page) throw new Error("拿不到 CDP page target");

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
    const r = await send("Runtime.evaluate", { expression: expr, awaitPromise, returnByValue: true });
    if (r.result && r.result.exceptionDetails) {
      return { __error: r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text };
    }
    return r.result?.result?.value;
  };

  // 1. 等前端 + 节点类型
  let boot = null;
  for (let i = 0; i < 90; i++) {
    boot = await evalJs(`(() => {
      const app = ${APP}, lg = window.LiteGraph;
      return { ready: !!(app && app.graph && app.canvas),
               hasOurs: !!(lg && lg.registered_node_types && lg.registered_node_types["MultiChannelSwitch"]) };
    })()`);
    if (boot && boot.ready && boot.hasOurs) break;
    await sleep(2000);
  }
  console.log("\n[1] 前端就绪:", JSON.stringify(boot));
  if (!boot || !boot.ready) throw new Error("前端没起来");

  // 2. 等画布稳定
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

  // 3. 建图：4 路源 + 多通道开关 + 2 个 SaveImage（分别接 ch1、ch2 输出）
  const built = await evalJs(`(() => {
    const app = ${APP}, g = app.graph;
    g.clear();
    const mk = (t) => { const n = window.LiteGraph.createNode(t); g.add(n); return n; };
    const route = [[32, 0xFF0000], [48, 0x00FF00], [64, 0x0000FF], [80, 0xFFFFFF]];
    const srcs = route.map(([size, color]) => {
      const n = mk("EmptyImage");
      n.widgets[0].value = size; n.widgets[1].value = size; n.widgets[3].value = color;
      return n;
    });
    const sw = mk("MultiChannelSwitch");
    const s1 = mk("SaveImage");
    const s2 = mk("SaveImage");
    if (s1.widgets[0]) s1.widgets[0].value = "mcs_ui_ch1";
    if (s2.widgets[0]) s2.widgets[0].value = "mcs_ui_ch2";
    window.__K = { srcs: srcs.map(n => n.id), sw: sw.id, s1: s1.id, s2: s2.id };
    return { ids: window.__K };
  })()`);
  if (built.__error) throw new Error("建图失败: " + built.__error);
  await sleep(700);

  const state = async () => {
    const r = await evalJs(`(() => {
      const app = ${APP}, n = app.graph.getNodeById(${built.ids.sw});
      if (!n) return { missing: true };
      const ins = (n.inputs || []).map(s => ({ n: s.name, linked: s.link != null, w: !!s.widget }));
      const outs = (n.outputs || []).map(s => ({ n: s.name, linked: (s.links || []).length > 0 }));
      return {
        inputs: ins.filter(s => !s.w).map(s => s.n),
        inputsLinked: ins.filter(s => !s.w).map(s => s.linked),
        outputs: outs.map(s => s.n),
        outputsLinked: outs.map(s => s.linked),
        totalInputEntries: ins.length,
      };
    })()`);
    return r;
  };

  const init = await state();
  console.log("\n[2] 刚建好:", JSON.stringify(init));
  check("默认只有 1 个通道的 2 个输入口", init.inputs.join(",") === "ch1_a,ch1_b", JSON.stringify(init.inputs));
  check("默认只露出 1 个输出口（后端声明的 8 个收起来了）",
    init.outputs.length === 1, JSON.stringify(init.outputs));

  // 每通道一个 force 下拉：8 个都在，但没长出来的通道那 7 个要折叠起来
  const forceState = async () => evalJs(`(() => {
    const app = ${APP}, sw = app.graph.getNodeById(${built.ids.sw});
    const list = (sw.widgets || []).filter(w => /^ch\\d+_force$/.test(w.name));
    return {
      total: list.length,
      visible: list.map(w => w.name),
      values: list.map(w => w.name + "=" + w.value),
      nodeH: Math.round(sw.size[1]),
    };
  })()`);

  const fs1 = await forceState();
  console.log("[2b] force 下拉状态:", JSON.stringify(fs1));
  check("只有 1 个通道时，画布上只保留 ch1_force 一行",
    fs1.total === 1 && fs1.visible.join(",") === "ch1_force",
    JSON.stringify(fs1));

  const connectIn = async (name, srcIndex) => {
    const r = await evalJs(`(() => {
      const app = ${APP}, g = app.graph;
      const src = g.getNodeById(${JSON.stringify(built.ids.srcs)}[${srcIndex}]);
      const sw = g.getNodeById(${built.ids.sw});
      const idx = sw.inputs.findIndex(s => s.name === ${JSON.stringify(name)});
      if (idx < 0) return { noSlot: true, have: (sw.inputs||[]).map(s => s.name) };
      src.connect(0, sw, idx);
      return { idx, linked: sw.inputs[idx].link != null };
    })()`);
    await sleep(450);
    return r;
  };

  const connectOut = async (outIndex, saveKey) => {
    const r = await evalJs(`(() => {
      const app = ${APP}, g = app.graph;
      const sw = g.getNodeById(${built.ids.sw});
      const save = g.getNodeById(${JSON.stringify(built.ids)}.${saveKey});
      if (!sw.outputs[${outIndex}]) return { noOut: true, outs: (sw.outputs||[]).map(s => s.name) };
      sw.connect(${outIndex}, save, 0);
      return { linked: save.inputs[0].link != null };
    })()`);
    await sleep(450);
    return r;
  };

  // 4. 逐个接：通道 1 接满 -> 长出通道 2
  const c1 = await connectIn("ch1_a", 0);
  const s1 = await state();
  check("接上 ch1_a（通道还没满）-> 不急着长新通道",
    s1.inputs.join(",") === "ch1_a,ch1_b" && s1.outputs.length === 1,
    `${JSON.stringify(s1.inputs)} / 输出 ${s1.outputs.length}`);

  const c2 = await connectIn("ch1_b", 1);
  const s2 = await state();
  console.log("\n[3] 通道1 接满后:", JSON.stringify(s2));
  check("通道 1 接满 -> 自动长出通道 2 的两个输入口",
    s2.inputs.join(",") === "ch1_a,ch1_b,ch2_a,ch2_b", JSON.stringify(s2.inputs));
  check("同时长出通道 2 的输出口", s2.outputs.join(",") === "ch1,ch2", JSON.stringify(s2.outputs));

  // 5. 两个 SaveImage 接到 ch1 / ch2 输出
  const o1 = await connectOut(0, "s1");
  const o2 = await connectOut(1, "s2");
  check("SaveImage#1 接到 ch1 输出", o1.linked === true, JSON.stringify(o1));
  check("SaveImage#2 接到 ch2 输出", o2.linked === true, JSON.stringify(o2));

  // 6. 通道 2 接满 -> 长出通道 3
  await connectIn("ch2_a", 2);
  await connectIn("ch2_b", 3);
  const s3 = await state();
  console.log("[4] 通道2 接满后:", JSON.stringify(s3));
  check("通道 2 接满 -> 长出通道 3（+2 输入 / +1 输出）",
    s3.inputs.join(",") === "ch1_a,ch1_b,ch2_a,ch2_b,ch3_a,ch3_b" && s3.outputs.join(",") === "ch1,ch2,ch3",
    `${JSON.stringify(s3.inputs)} / ${JSON.stringify(s3.outputs)}`);

  const fs3 = await forceState();
  console.log("[4b] 长到 3 通道后的 force 下拉:", JSON.stringify(fs3));
  check("长到 3 通道后，画布上是 ch1~ch3_force 三行",
    fs3.total === 3 && fs3.visible.join(",") === "ch1_force,ch2_force,ch3_force",
    JSON.stringify(fs3.visible));

  // 7. 静音通道 1 的 a，排队验证两个输出各走各的
  const historyIds = async () => new Set(Object.keys(JSON.parse(await get(`${COMFY}/history`))));
  const queueAndCheck = async (label, expect) => {
    const before = await historyIds();
    const qres = await evalJs(
      `(() => { const app = ${APP}; return app.queuePrompt(0, 1).then(r => JSON.stringify({ ok: r })).catch(e => 'ERR: ' + (e && (e.message || e))); })()`,
      true,
    );
    const qs = String(qres);
    if (qs.startsWith("ERR") || qs.includes('"ok":false')) {
      check(label, false, `queuePrompt=${qs.slice(0, 200)}`);
      return;
    }
    let hist = null;
    for (let i = 0; i < 120 && !hist; i++) {
      await sleep(1000);
      const all = JSON.parse(await get(`${COMFY}/history`));
      const key = Object.keys(all).find((k) => !before.has(k));
      if (key) hist = all[key];
    }
    if (!hist) throw new Error(label + ": 等不到执行结果");
    const status = hist.status || {};
    if (status.status_str !== "success") {
      check(label, false, JSON.stringify(status.messages || []).slice(0, 300));
      return;
    }
    const details = [];
    let ok = true;
    for (const [saveKey, size] of expect) {
      const saveId = built.ids[saveKey];
      const images = ((hist.outputs || {})[saveId] || {}).images || [];
      if (!images[0]) {
        ok = false;
        details.push(`${saveKey}: 没产物`);
        continue;
      }
      const vq = `filename=${encodeURIComponent(images[0].filename)}&subfolder=${encodeURIComponent(images[0].subfolder || "")}&type=${images[0].type || "output"}`;
      const bytes = await getBuf(`${COMFY}/view?${vq}`);
      const w = bytes.readUInt32BE(16);
      const hgt = bytes.readUInt32BE(20);
      ok = ok && w === size && hgt === size;
      details.push(`${saveKey}=${w}x${hgt}` + (w === size && hgt === size ? "" : `(期望${size})`));
    }
    check(label, ok, details.join("; "));
  };

  await queueAndCheck("不静音时：ch1=32x32(红)、ch2=64x64(蓝)", [["s1", 32], ["s2", 64]]);

  await evalJs(`(() => { const app = ${APP}; app.graph.getNodeById(${JSON.stringify(built.ids.srcs)}[0]).mode = 2; return 1; })()`);
  await queueAndCheck("静音通道1的 a 后：ch1 自动用 b(48x48)，ch2 不受影响(64x64)",
    [["s1", 48], ["s2", 64]]);

  // 8. 存盘 -> 加载
  const reload = await evalJs(`(async () => {
    const app = ${APP}, g = app.graph;
    const data = JSON.parse(JSON.stringify(g.serialize()));
    await app.loadGraphData(data, true, true, "mcs-roundtrip");
    await new Promise(r => setTimeout(r, 800));
    const sw = app.graph.getNodeById(${built.ids.sw});
    if (!sw) return { missing: true };
    const ins = (sw.inputs || []).filter(s => !s.widget);
    const outs = sw.outputs || [];
    return {
      inputs: ins.map(s => s.n || s.name),
      inputsLinked: ins.map(s => s.link != null),
      outputs: outs.map(s => s.name),
      outputsLinked: outs.map(s => (s.links || []).length > 0),
    };
  })()`, true);
  console.log("\n[5] 存盘再加载后:", JSON.stringify(reload));
  check("加载后通道数还是 3（输入口 6 个）", (reload?.inputs || []).length === 6, JSON.stringify(reload?.inputs));
  check("加载后输出口还是 3 个", (reload?.outputs || []).length === 3, JSON.stringify(reload?.outputs));
  check("加载后 ch1/ch2 的输入连线还在",
    (reload?.inputsLinked || []).slice(0, 4).every(Boolean), JSON.stringify(reload?.inputsLinked));
  check("加载后 ch1/ch2 的输出连线还在",
    (reload?.outputsLinked || []).slice(0, 2).every(Boolean), JSON.stringify(reload?.outputsLinked));

  // 9. 右键菜单：加一个通道 / 删掉最后一个空通道
  const menu = await evalJs(`(() => {
    const app = ${APP}, sw = app.graph.getNodeById(${built.ids.sw});
    const opts = [];
    sw.getExtraMenuOptions(app.canvas, opts);
    const items = (opts || []).filter(Boolean).map(o => o.content);
    const fire = (label) => {
      const it = (opts || []).filter(Boolean).find(o => String(o.content).includes(label));
      if (it && typeof it.callback === "function") it.callback();
    };
    const before = { ins: (sw.inputs || []).filter(s => !s.widget).length, outs: (sw.outputs || []).length };
    fire("加一个通道");
    const afterAdd = { ins: (sw.inputs || []).filter(s => !s.widget).length, outs: (sw.outputs || []).length };
    fire("删掉最后一个空通道");
    const afterRemove = { ins: (sw.inputs || []).filter(s => !s.widget).length, outs: (sw.outputs || []).length };
    return { items, before, afterAdd, afterRemove };
  })()`);
  console.log("\n[6] 右键菜单:", JSON.stringify(menu));
  const menuHas = (s) => (menu?.items || []).some((i) => String(i).includes(s));
  check("菜单里有「加一个通道」「删掉最后一个空通道」",
    menuHas("加一个通道") && menuHas("删掉最后一个空通道"), JSON.stringify(menu?.items));
  check("加一个通道 -> 输入 +2、输出 +1",
    menu?.afterAdd?.ins === menu?.before?.ins + 2 && menu?.afterAdd?.outs === menu?.before?.outs + 1,
    JSON.stringify(menu));
  check("删掉最后一个空通道 -> 回到原样",
    menu?.afterRemove?.ins === menu?.before?.ins && menu?.afterRemove?.outs === menu?.before?.outs,
    JSON.stringify(menu));

  // 10. 取消静音再排一次，回到 32x32
  await evalJs(`(() => {
    const app = ${APP}, g = app.graph;
    for (const id of ${JSON.stringify(built.ids.srcs)}) { const n = g.getNodeById(id); if (n) n.mode = 0; }
    return 1;
  })()`);
  await queueAndCheck("取消静音后：ch1 回到 32x32、ch2 仍 64x64", [["s1", 32], ["s2", 64]]);

  // 11. 强制选择：把 force 切到 b —— 即使 a 有值，也必须走 b
  const fw = await evalJs(`(() => {
    const app = ${APP}, sw = app.graph.getNodeById(${built.ids.sw});
    const w = (sw.widgets || []).find(x => x.name === "force");
    if (!w) return { missing: true, names: (sw.widgets || []).map(x => x.name) };
    w.value = "b";
    return { names: (sw.widgets || []).map(x => x.name), value: w.value };
  })()`);
  console.log("\n[7] force 控件:", JSON.stringify(fw));
  check("节点上有 force 控件（auto/a/b/c）", fw?.missing !== true, JSON.stringify(fw));

  await queueAndCheck("force=b：a 有值也强制走 b（ch1=48x48、ch2=80x80）",
    [["s1", 48], ["s2", 80]]);

  await evalJs(`(() => {
    const app = ${APP}, sw = app.graph.getNodeById(${built.ids.sw});
    const w = (sw.widgets || []).find(x => x.name === "force");
    if (w) w.value = "a";
    return 1;
  })()`);
  await queueAndCheck("force=a：两块都走 a（ch1=32x32、ch2=64x64）",
    [["s1", 32], ["s2", 64]]);

  await evalJs(`(() => {
    const app = ${APP}, sw = app.graph.getNodeById(${built.ids.sw});
    const w = (sw.widgets || []).find(x => x.name === "force");
    if (w) w.value = "auto";
    return 1;
  })()`);
  await queueAndCheck("切回 auto：又变回自动挑（ch1=32x32、ch2=64x64）",
    [["s1", 32], ["s2", 64]]);

  // 12. 每通道各自强制：ch1_force=b，ch2 保持 auto -> ch1=48x48、ch2=64x64
  const setWidget = async (name, value) =>
    evalJs(`(() => {
      const app = ${APP}, sw = app.graph.getNodeById(${built.ids.sw});
      const w = (sw.widgets || []).find(x => x.name === ${JSON.stringify(name)});
      if (!w) return { missing: true };
      w.value = ${JSON.stringify(value)};
      return { name: w.name, value: w.value };
    })()`);

  const setCh1 = await setWidget("ch1_force", "b");
  console.log("\n[8] 每通道强制:", JSON.stringify(setCh1));
  check("能给单个通道设 ch1_force=b", setCh1?.value === "b", JSON.stringify(setCh1));
  await queueAndCheck("ch1_force=b、ch2 仍 auto：ch1=48x48(b)、ch2=64x64(a)",
    [["s1", 48], ["s2", 64]]);

  await setWidget("ch1_force", "a");
  await setWidget("ch2_force", "b");
  await queueAndCheck("反过来：ch1_force=a -> 32x32、ch2_force=b -> 80x80",
    [["s1", 32], ["s2", 80]]);

  await setWidget("ch1_force", "auto");
  await setWidget("ch2_force", "auto");
  await queueAndCheck("两个都切回 auto：恢复自动挑（32x32 / 64x64）",
    [["s1", 32], ["s2", 64]]);

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
