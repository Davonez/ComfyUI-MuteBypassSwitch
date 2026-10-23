/**
 * 多路汇聚开关 (MultiAnySwitch) 前端真机验证 —— headless Edge + CDP
 *
 * 验的是"任意路"这件事在真实画布上成不成立：
 *   1. 初始只有 2 个输入口；
 *   2. 每把最后一路接上线，就自动多长出一个空口（1→2→3→4 路）；
 *   3. 4 路全接时排队，用的是第 1 路（32x32 红）；
 *   4. 把第 1 路静音(mode=2)后再排队 -> 用第 2 路（48x48 绿）；
 *   5. 再把第 2 路也静音 -> 用第 3 路（64x64 蓝）；
 *   6. 存盘再加载（serialize -> loadGraphData）后，多出来的输入口和连线都还在；
 *   7. 重新排队仍然正确。
 *
 * 用法: node test_multi_frontend_cdp.js
 */

const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const CDP_PORT = 9337;
const COMFY = "http://127.0.0.1:8188";
const USER_DIR = path.join(os.tmpdir(), "mbs-multi-" + Date.now());
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
  // 0. 前端扩展文件有没有被 ComfyUI 挂出去
  const jsUrl = `${COMFY}/extensions/ComfyUI-MuteBypassSwitch/multi_any_switch.js`;
  let jsOk = false;
  let jsLen = 0;
  try {
    const body = await get(jsUrl);
    jsOk = body.includes("MultiAnySwitch");
    jsLen = body.length;
  } catch (e) {}
  check("前端扩展已被服务器挂出", jsOk, `${jsUrl} (${jsLen} bytes)`);

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
               hasOurs: !!(lg && lg.registered_node_types && lg.registered_node_types["MultiAnySwitch"]) };
    })()`);
    if (boot && boot.ready && boot.hasOurs) break;
    await sleep(2000);
  }
  console.log("\n[1] 前端就绪:", JSON.stringify(boot));
  if (!boot || !boot.ready) throw new Error("前端没起来");

  // 2. 等画布稳定（防止模板异步替换画面）
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

  // 3. 建图：4 路不同尺寸/颜色的 EmptyImage
  const built = await evalJs(`(() => {
    const app = ${APP}, g = app.graph;
    g.clear();
    const mk = (t) => { const n = window.LiteGraph.createNode(t); g.add(n); return n; };
    const route = [[32, 0xFF0000], [48, 0x00FF00], [64, 0x0000FF], [80, 0xFFFFFF]];
    const srcs = route.map(([size, color]) => {
      const n = mk("EmptyImage");
      n.widgets[0].value = size; n.widgets[1].value = size;
      n.widgets[3].value = color;
      return n;
    });
    const sw = mk("MultiAnySwitch");
    const save = mk("SaveImage");
    if (save.widgets[0]) save.widgets[0].value = "mbs_multi_ui";
    const wSwitch = (sw.widgets || []).find(w => w.name === "switch");
    const wPick = (sw.widgets || []).find(w => w.name === "pick");
    if (wSwitch) wSwitch.value = true;
    if (wPick) wPick.value = "first";
    const outErr = sw.connect(0, save, 0);   // 开关输出 -> SaveImage.images
    window.__K = { srcs: srcs.map(n => n.id), sw: sw.id, save: save.id };
    return {
      ids: window.__K,
      slots: (sw.inputs || []).map(s => ({ name: s.name, type: s.type })),
      outLink: save.inputs?.[0]?.link != null,
      outErr: outErr || null,
    };
  })()`);
  if (built.__error) throw new Error("建图失败: " + built.__error);
  console.log("\n[2] 建图完成:", JSON.stringify(built));



  const slotNames = async () => {
    const r = await evalJs(`(() => {
      const app = ${APP}, n = app.graph.getNodeById(${built.ids.sw});
      if (!n) return { missing: true };
      const all = (n.inputs || []).map(s => ({ name: s.name, link: s.link != null }));
      // 只取真正的输入口 input_N（控件 switch / pick 也挂在 inputs 里）
      const ours = all.filter(s => /^input_\\d+$/.test(s.name));
      return {
        names: ours.map(s => s.name),
        linked: ours.map(s => s.link),
        allNames: all.map(s => s.name),
        firstWidgetPos: all.findIndex(s => !/^input_\\d+$/.test(s.name)),
      };
    })()`);
    return r;
  };

  const connectRoute = async (k) => {
    const r = await evalJs(`(() => {
      const app = ${APP}, g = app.graph;
      const src = g.getNodeById(${built.ids.srcs[k - 1]});
      const sw = g.getNodeById(${built.ids.sw});
      if (!src || !sw) return { missing: true };
      const idx = sw.inputs.findIndex(s => s.name === "input_${k}");
      if (idx < 0) return { noSlot: idx };
      const err = src.connect(0, sw, idx);
      return { idx, err: err ? String(err) : null, link: sw.inputs[idx].link != null };
    })()`);
    await sleep(400); // 等前端扩展的 setTimeout 补齐空口
    return r;
  };

  // 4. 逐路接上，看口自动变多
  // 4. 右键菜单：手动加 / 删一路（不用先接线）
  const menu = await evalJs(`(() => {
    const app = ${APP}, sw = app.graph.getNodeById(${built.ids.sw});
    const count = () => (sw.inputs || []).filter(s => /^input_\\d+$/.test(s.name)).length;
    const opts = [];
    sw.getExtraMenuOptions(app.canvas, opts);
    const items = (opts || []).filter(Boolean).map(o => o.content);
    const fire = (label) => {
      const it = (opts || []).filter(Boolean).find(o => String(o.content).includes(label));
      if (it && typeof it.callback === "function") it.callback();
    };
    const before = count();
    fire("增加一路输入");
    const afterAdd = count();
    fire("删掉最后一路空口");
    const afterRemove = count();
    return { items, before, afterAdd, afterRemove };
  })()`);
  console.log("\n[2b] 右键菜单:", JSON.stringify(menu));
  const menuHas = (s) => Array.isArray(menu?.items) && menu.items.some((i) => String(i).includes(s));
  check("右键菜单里三项都在（会和其他插件的菜单项混在一起）",
    menuHas("增加一路输入") && menuHas("删掉最后一路空口") && menuHas("整理空输入口"),
    JSON.stringify(menu?.items));
  check("菜单「增加一路输入」-> 2 变 3", menu?.before === 2 && menu?.afterAdd === 3,
    JSON.stringify(menu));
  check("菜单「删掉最后一路空口」-> 3 变 2", menu?.afterRemove === 2, JSON.stringify(menu));

  // 5. 逐路接上，看口自动变多
  const initSlots = await slotNames();
  check("初始只有 2 个输入口", initSlots.names.join(",") === "input_1,input_2",
    JSON.stringify(initSlots.allNames));
  check("输入口都排在控件前面（口在上、控件在下）",
    initSlots.firstWidgetPos === 2, `第一个控件位置=${initSlots.firstWidgetPos}`);
  check("开关输出 -> SaveImage.images 已连上", built.outLink === true, JSON.stringify(built.outErr));

  for (let k = 1; k <= 4; k++) {
    const c = await connectRoute(k);
    const s = await slotNames();
    if (c.missing || c.noSlot !== undefined) throw new Error(`第 ${k} 路没有对应插槽: ${JSON.stringify(c)}`);
    const expectNames = Array.from({ length: k + 1 }, (_, i) => `input_${i + 1}`).join(",");
    check(`接上第 ${k} 路 -> 自动长出第 ${k + 1} 个空口`,
      s.names.join(",") === expectNames,
      `当前 ${s.names.length} 个口: ${s.names.join(",")}`);
  }

  const after4 = await slotNames();
  check("4 路全都连上", after4.linked.slice(0, 4).every(Boolean), JSON.stringify(after4.linked));

  // 5. 排队工具
  const historyIds = async () => new Set(Object.keys(JSON.parse(await get(`${COMFY}/history`))));

  const queueAndCheck = async (label, expectSize) => {
    const before = await historyIds();
    const qres = await evalJs(
      `(() => { const app = ${APP}; return app.queuePrompt(0, 1).then(r => JSON.stringify({ ok: r })).catch(e => 'ERR: ' + (e && (e.message || e))); })()`,
      true,
    );
    const qs = String(qres);
    if (qs.startsWith("ERR") || qs.includes('"ok":false')) {
      // 前端说没排上 —— 把同一个 prompt 直接 POST 给后端，看是前端拦的还是后端拒的
      const diag = await evalJs(`(async () => {
        const app = ${APP};
        const p = await app.graphToPrompt();
        const res = await fetch('/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: p.output, client_id: 'diag-probe' }) });
        const body = await res.text();
        const modals = Array.from(document.querySelectorAll('.comfy-modal, .p-dialog, [role="dialog"]')).map(e => (e.innerText || '').slice(0, 300));
        return JSON.stringify({ status: res.status, body: body.slice(0, 800), modals });
      })()`, true);
      check(label, false, `queuePrompt=${qs.slice(0, 120)} 诊断=${String(diag).slice(0, 900)}`);
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
    const imgs = Object.values(hist.outputs || {}).flatMap((o) => o.images || []);
    if (status.status_str !== "success" || !imgs[0]) {
      check(label, false, JSON.stringify(status.messages || []).slice(0, 300));
      return;
    }
    const vq = `filename=${encodeURIComponent(imgs[0].filename)}&subfolder=${encodeURIComponent(imgs[0].subfolder || "")}&type=${imgs[0].type || "output"}`;
    const bytes = await getBuf(`${COMFY}/view?${vq}`);
    const w = bytes.readUInt32BE(16);
    const hgt = bytes.readUInt32BE(20);
    check(`${label} -> 产物 ${w}x${hgt}`, w === expectSize && hgt === expectSize, `期望 ${expectSize}x${expectSize}`);
  };

  // 6. 4 路全接：应走第 1 路 32x32
  const p = await evalJs(`(() => { const app = ${APP}; return app.graphToPrompt().then(x => JSON.stringify(x.output[${built.ids.sw}].inputs)).catch(e => 'ERR ' + e); })()`, true);
  console.log("\n[3] prompt 里的输入:", p);
  check("prompt 里确实带上了没声明的 input_3 / input_4",
    typeof p === "string" && p.includes("input_3") && p.includes("input_4"), String(p).slice(0, 200));

  await queueAndCheck("4 路全接时用第 1 路(32x32)", 32);

  // 7. 静音第 1 路 -> 第 2 路 48x48
  await evalJs(`(() => { const app = ${APP}; app.graph.getNodeById(${built.ids.srcs[0]}).mode = 2; return 1; })()`);
  await queueAndCheck("静音第 1 路后用第 2 路(48x48)", 48);

  // 8. 再静音第 2 路 -> 第 3 路 64x64
  await evalJs(`(() => { const app = ${APP}; app.graph.getNodeById(${built.ids.srcs[1]}).mode = 2; return 1; })()`);
  await queueAndCheck("静音 1、2 路后用第 3 路(64x64)", 64);

  // 9. 存盘再加载，看多出来的口和连线还在不在
  const reload = await evalJs(`(async () => {
    const app = ${APP}, g = app.graph;
    const data = JSON.parse(JSON.stringify(g.serialize()));
    await app.loadGraphData(data, true, true, "mbs-multi-roundtrip");
    await new Promise(r => setTimeout(r, 600));
    const sw = app.graph.getNodeById(${built.ids.sw});
    if (!sw) return { missing: true, ids: app.graph._nodes.map(n => n.id) };
    const all = (sw.inputs || []).map(s => ({ name: s.name, link: s.link != null }));
    const ours = all.filter(s => /^input_\\d+$/.test(s.name));
    return {
      names: ours.map(s => s.name),
      linked: ours.map(s => s.link),
      allNames: all.map(s => s.name),
    };
  })()`, true);
  console.log("\n[4] 存盘再加载后:", JSON.stringify(reload));
  check("加载后 4 个口都在", Array.isArray(reload?.names) && reload.names.length >= 4,
    JSON.stringify(reload?.names));
  check("加载后前 4 路的连线都还原了", Array.isArray(reload?.linked) && reload.linked.slice(0, 4).every(Boolean),
    JSON.stringify(reload?.linked));
  check("加载后 input_1~input_5 都还在",
    Array.isArray(reload?.names) && reload.names.join(",").startsWith("input_1,input_2,input_3,input_4,input_5"),
    JSON.stringify(reload?.allNames));

  // 9b. 二次存盘：检查序列化出来的 links 是否指向正确的口（防止重排把 target_slot 弄错）
  const rt2 = await evalJs(`(async () => {
    const app = ${APP};
    const data = app.graph.serialize();
    const sw = (data.nodes || []).find(n => String(n.id) === "${built.ids.sw}");
    if (!sw) return { missing: true };
    const names = (sw.inputs || []).map(s => s.name);
    const myLinks = (data.links || [])
      .filter(l => String(l[3]) === String(sw.id))
      .map(l => names[l[4]]);
    return { names, linkTargets: myLinks };
  })()`, true);
  console.log("[5] 二次序列化的连线指向:", JSON.stringify(rt2));
  check("存盘JSON里每根线都指向 input_1..input_4",
    JSON.stringify((rt2?.linkTargets || []).slice().sort()) ===
      JSON.stringify(["input_1", "input_2", "input_3", "input_4"]),
    JSON.stringify(rt2?.linkTargets));

  // 10. 取消静音后再跑一次，应回到第 1 路 32x32
  await evalJs(`(() => {
    const app = ${APP}, g = app.graph;
    for (const id of ${JSON.stringify(built.ids.srcs)}) { const n = g.getNodeById(id); if (n) n.mode = 0; }
    return 1;
  })()`);
  await queueAndCheck("取消静音后回到第 1 路(32x32)", 32);

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
