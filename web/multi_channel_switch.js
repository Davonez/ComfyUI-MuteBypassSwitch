/**
 * 多通道汇聚开关 (Multi Channel Switch) —— 前端扩展
 * =====================================================================
 * 需求：**输入侧和输出侧都能自动加路**。
 *
 * 机制：
 *   * 后端一次声明了 8 个输出口（引擎的 RETURN_TYPES 不能动态长），画布上默认只留 1 个；
 *   * 每个"通道"= 2 个候选输入（ch{k}_a / ch{k}_b）+ 1 个输出（ch{k}）；
 *   * 第 k 个通道接满（a、b 都连上了）-> 自动长出第 k+1 个通道：
 *     多 2 个输入口 + 多 1 个输出口；
 *   * 也支持右键「＋ 加一个通道 / － 删掉最后一个空通道 / 整理空输入口」手动来。
 *
 * 两条铁律（踩过坑）：
 *   1) 只往数组末尾追加，绝不插到中间、绝不重排 —— 因为 graph.links 里的
 *      origin_slot / target_slot 都是数组下标，重排会让工作流存盘后接错线；
 *   2) 删只删"末尾的、没连线的"，有线的口一律不动。
 */

import { app } from "../../scripts/app.js";

const NODE_TYPE = "MultiChannelSwitch";
const MAX_CHANNELS = 8;
const LETTERS = "abcdefghij";
const MIN_PER_CHANNEL = 2; // 每个通道至少 a、b 两个候选口

const channelName = (ch, i) => `ch${ch}_${LETTERS[i]}`;
const parse = (name) => {
  const m = /^ch(\d+)_([a-z])$/.exec(String(name ?? ""));
  if (!m) return null;
  const ch = Number(m[1]);
  const i = LETTERS.indexOf(m[2]);
  if (ch < 1 || ch > MAX_CHANNELS || i < 0) return null;
  return { ch, i };
};

function refit(node) {
  try {
    const size = node.computeSize();
    node.setSize([Math.max(node.size?.[0] ?? size[0], size[0]), size[1]]);
    app.graph.setDirtyCanvas(true, false);
  } catch (e) {
    /* 尺寸算不出来不影响功能 */
  }
}

/** 每个通道当前的候选口数量、已连到第几路。 */
function channelState(node) {
  const state = new Map();
  for (let ch = 1; ch <= MAX_CHANNELS; ch++) state.set(ch, { count: 0, lastLinked: 0 });
  for (const slot of node.inputs ?? []) {
    const info = parse(slot?.name);
    if (!info) continue;
    const s = state.get(info.ch);
    s.count = Math.max(s.count, info.i + 1);
    if (slot.link != null) s.lastLinked = Math.max(s.lastLinked, info.i + 1);
  }
  return state;
}

/** 画布上应该显示几个通道：用得最深的通道 + 一个空位，最少 1 个。 */
function wantedChannels(node) {
  const state = channelState(node);
  let usedIn = 0;
  let full = 0;
  for (const [ch, s] of state) {
    if (s.count > 0) usedIn = Math.max(usedIn, ch);
    if (s.lastLinked >= MIN_PER_CHANNEL) full = Math.max(full, ch);
  }
  let usedOut = 0;
  (node.outputs ?? []).forEach((slot, i) => {
    if (slot && (slot.links || []).length > 0) usedOut = i + 1;
  });
  return Math.min(MAX_CHANNELS, Math.max(1, usedIn, full + 1, usedOut));
}

/** 补输入口：通道 1..want 每个都要有 a、b（不够就往后追加，只加在数组末尾）。 */
function growInputs(node, want) {
  const state = channelState(node);
  let changed = false;
  for (let ch = 1; ch <= want; ch++) {
    const have = state.get(ch)?.count ?? 0;
    for (let i = have; i < MIN_PER_CHANNEL; i++) {
      const before = node.inputs.length;
      node.addInput(channelName(ch, i), "*");
      if (node.inputs.length !== before + 1) return changed;
      changed = true;
    }
  }
  return changed;
}

/** 补 / 收输出口：输出只保留 want 个，多出来的"末尾且没连线"的删掉。 */
function syncOutputs(node, want) {
  let changed = false;
  while (node.outputs.length > want) {
    const pos = node.outputs.length - 1;
    const slot = node.outputs[pos];
    if (!slot || (slot.links || []).length > 0) break; // 有线的输出绝不删
    try {
      node.removeOutput(pos);
    } catch (e) {
      break;
    }
    changed = true;
  }
  while (node.outputs.length < want) {
    const before = node.outputs.length;
    node.addOutput(`ch${before + 1}`, "*");
    if (node.outputs.length !== before + 1) break;
    changed = true;
  }
  return changed;
}

const FORCE_RE = /^ch(\d+)_force$/;
const FORCE_VALUES = ["auto", "a", "b", "c"];

/**
 * 每个通道有自己的 force 下拉，后端静态声明了 8 个。
 * 画布上只保留「已经长出来的通道」那几行 —— 这里直接把多余的从 node.widgets 里摘掉，
 * 需要时再用 addWidget 加回来（实测：addWidget 出来的控件，值照样会进 prompt、也会存盘）。
 *
 * 为什么不用"把高度压成 0"那套折叠技巧：这个前端（1.53）里压扁后控件仍然会被绘制，
 * 结果末尾会漏出一行、中间留空洞，很难看。
 *
 * 存盘安全性：widgets_values 是按 node.widgets 的顺序存的，摘掉末尾的控件不会让
 * 前面的值错位；重新加载时前端按名字/顺序还原，缺的通道就是默认 auto。
 */
function syncForceWidgets(node, want) {
  let changed = false;

  // 1) 摘掉超出 want 的通道控件
  node.widgets = (node.widgets || []).filter((w) => {
    const m = FORCE_RE.exec(String(w?.name ?? ""));
    if (!m) return true;
    if (Number(m[1]) <= want) return true;
    changed = true;
    return false;
  });

  // 2) 补上缺的（追加在末尾，顺序和通道号一致）
  for (let ch = 1; ch <= want; ch++) {
    if ((node.widgets || []).some((w) => w?.name === `ch${ch}_force`)) continue;
    const w = node.addWidget("combo", `ch${ch}_force`, "auto", () => {}, {
      values: FORCE_VALUES.slice(),
    });
    if (!w) break;
    changed = true;
  }
  return changed;
}

function syncNode(node) {
  if (!node || node.type !== NODE_TYPE) return;
  if (!Array.isArray(node.inputs)) node.inputs = [];
  if (!Array.isArray(node.outputs)) node.outputs = [];
  const want = wantedChannels(node);
  const a = growInputs(node, want);
  const b = syncOutputs(node, want);
  const c = syncForceWidgets(node, want);
  if (a || b || c) refit(node);
}

/**
 * 延迟一拍再同步：连线/加载工作流是同步的一串操作，等这一串做完再动插槽，
 * 避免在"线还没还原完"的中间状态里动刀。
 */
function scheduleSync(node) {
  if (node.__mcsPending) return;
  node.__mcsPending = true;
  setTimeout(() => {
    node.__mcsPending = false;
    syncNode(node);
  }, 0);
}

/** 右键菜单：手动加一个通道（输入侧 +2、输出侧 +1，并展开它的 force 下拉）。 */
function addChannel(node) {
  if (!node || node.type !== NODE_TYPE) return;
  const state = channelState(node);
  let next = 1;
  for (const [ch, s] of state) if (s.count > 0) next = Math.max(next, ch + 1);
  if (next > MAX_CHANNELS) return;
  const before = node.inputs.length;
  for (let i = 0; i < MIN_PER_CHANNEL; i++) node.addInput(channelName(next, i), "*");
  if (node.inputs.length === before && node.outputs.length >= next) return;
  syncOutputs(node, Math.max(next, node.outputs.length));
  syncNode(node);
  app.graph.afterChange?.();
}

/** 右键菜单：删掉最后一个"没有任何连线"的通道（输入 2 个口 + 输出 1 个口）。 */
function removeChannel(node) {
  if (!node || node.type !== NODE_TYPE) return;
  const state = channelState(node);
  let last = 0;
  for (const [ch, s] of state) if (s.count > 0) last = Math.max(last, ch);
  if (last <= 1) return; // 至少留一个通道
  const s = state.get(last);
  if (s.lastLinked > 0) return; // 这个通道还有线，不删

  // 从末尾删掉属于该通道的输入口
  for (let i = node.inputs.length - 1; i >= 0; i--) {
    const info = parse(node.inputs[i]?.name);
    if (!info || info.ch !== last) continue;
    if (node.inputs[i].link != null) return;
    try {
      node.removeInput(i);
    } catch (e) {
      return;
    }
  }
  // 再收掉对应输出口
  if (node.outputs.length >= last) {
    const slot = node.outputs[last - 1];
    if (slot && (slot.links || []).length === 0) {
      try {
        node.removeOutput(last - 1);
      } catch (e) {
        /* 忽略 */
      }
    }
  }
  syncNode(node);
  app.graph.afterChange?.();
}

app.registerExtension({
  name: "koivis.MultiChannelSwitch",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== NODE_TYPE) return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated?.apply(this, arguments);
      syncNode(this); // 建好就收成一个通道
      return r;
    };

    const onConnectionsChange = nodeType.prototype.onConnectionsChange;
    nodeType.prototype.onConnectionsChange = function (type) {
      const r = onConnectionsChange?.apply(this, arguments);
      if (type === 1 || type === 2) scheduleSync(this); // 1=输入 2=输出
      return r;
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const r = onConfigure?.apply(this, arguments);
      scheduleSync(this); // 加载工作流后对齐通道数量
      return r;
    };

    const getExtraMenuOptions = nodeType.prototype.getExtraMenuOptions;
    nodeType.prototype.getExtraMenuOptions = function (canvas, options) {
      const r = getExtraMenuOptions?.apply(this, arguments);
      if (Array.isArray(options)) {
        options.push(
          null,
          {
            content: "+ Add a channel (+2 inputs / +1 output)",
            callback: () => addChannel(this),
          },
          {
            content: "- Remove the last empty channel",
            callback: () => removeChannel(this),
          },
        );
      }
      return r;
    };
  },

  nodeCreated(node) {
    if (node.type === NODE_TYPE) scheduleSync(node);
  },
});
