/**
 * 输出分发开关 (Output Fanout Switch) —— 前端扩展（新手友好版）
 * =====================================================================
 * The node has only two kinds of widgets:
 *   "outputs_per_input": 2 / 3 / 4
 *   one on/off dropdown per output
 *
 * Outputs are paired with inputs automatically:
 *   2 per input -> out_1/out_2 follow in_1, out_3/out_4 follow in_2 ...
 *   3 per input -> out_1..out_3 follow in_1, out_4..out_6 follow in_2 ...
 *
 * On canvas: connecting input 1 creates n outputs; connecting input 2 adds n more
 * (plus one spare input slot). The on/off dropdown only appears for outputs that exist.
 *
 * 三条铁律（前面几个节点踩出来的）：
 *   1) 插槽只往数组末尾追加、绝不重排（graph.links 存的是下标）；
 *   2) 只删"末尾且没连线"的插槽；
 *   3) 下拉用「从 node.widgets 里摘掉 / addWidget 加回来」来增删。
 */

import { app } from "../../scripts/app.js";

const NODE_TYPE = "OutputFanoutSwitch";
const MAX_INPUTS = 8;
const MAX_PER_INPUT = 4;
const MAX_OUTPUTS = MAX_INPUTS * MAX_PER_INPUT;
const PER_INPUT_NAME = "outputs_per_input";
const ON_OFF_VALUES = ["on", "off"];
const OUT_RE = /^output_(\d+)$/;

const parseInput = (name) => {
  const m = /^in_(\d+)$/.exec(String(name ?? ""));
  return m ? Number(m[1]) : -1;
};

function refit(node) {
  try {
    const size = node.computeSize();
    node.setSize([Math.max(node.size?.[0] ?? size[0], size[0]), size[1]]);
    app.graph.setDirtyCanvas(true, false);
  } catch (e) {
    /* 算不出尺寸不影响功能 */
  }
}

/** 当前「每个输入配几个输出」= 2/3/4。 */
function perInputCount(node) {
  const w = (node.widgets ?? []).find((x) => x?.name === PER_INPUT_NAME);
  const raw = String(w?.value ?? "2");
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? Math.max(1, Math.min(MAX_PER_INPUT, n)) : 2;
}

function lastLinkedInput(node) {
  let last = 0;
  for (const slot of node.inputs ?? []) {
    const i = parseInput(slot?.name);
    if (i > 0 && slot.link != null) last = Math.max(last, i);
  }
  return last;
}

function connectedInputCount(node) {
  let count = 0;
  for (const slot of node.inputs ?? []) {
    if (parseInput(slot?.name) > 0 && slot.link != null) count += 1;
  }
  return count;
}

function inputCount(node) {
  return (node.inputs ?? []).filter((s) => parseInput(s?.name) > 0).length;
}

/** 输入口：保持「已连线的最后一路 + 1 个空位」，至少 1 个。 */
function growInputs(node) {
  const want = Math.min(MAX_INPUTS, Math.max(1, lastLinkedInput(node) + 1));
  let changed = false;
  for (let i = inputCount(node) + 1; i <= want; i++) {
    const before = node.inputs.length;
    node.addInput(`in_${i}`, "*");
    if (node.inputs.length !== before + 1) break;
    changed = true;
  }
  return changed;
}

/** 输出口：接了几路输入就出 几路 × n 个，最少 n 个；末尾没连线的多出来就收掉。 */
function syncOutputs(node) {
  const n = perInputCount(node);
  const pairs = Math.max(1, connectedInputCount(node));
  const want = Math.min(MAX_OUTPUTS, pairs * n);
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
    node.addOutput(`out_${before + 1}`, "*");
    if (node.outputs.length !== before + 1) break;
    changed = true;
  }
  return changed;
}

/** 每个输出一行「开/关」：只保留已经长出来的输出那些行。 */
function syncOutputWidgets(node) {
  const want = node.outputs.length;
  let changed = false;

  node.widgets = (node.widgets || []).filter((w) => {
    const m = OUT_RE.exec(String(w?.name ?? ""));
    if (!m) return true;
    if (Number(m[1]) <= want) return true;
    changed = true;
    return false;
  });

  for (let i = 1; i <= want; i++) {
    if ((node.widgets || []).some((w) => w?.name === `output_${i}`)) continue;
    const w = node.addWidget("combo", `output_${i}`, "on", () => {}, { values: ON_OFF_VALUES.slice() });
    if (!w) break;
    changed = true;
  }
  return changed;
}

/** 给「每个输入配几个输出」挂上回调：改了以后输出口数量要跟着变。 */
function hookPerInputWidget(node) {
  const w = (node.widgets ?? []).find((x) => x?.name === PER_INPUT_NAME);
  if (!w || w.__ofsHooked) return;
  const original = w.callback;
  w.callback = function (...args) {
    const r = original?.apply(this, args);
    scheduleSync(node);
    return r;
  };
  w.__ofsHooked = true;
}

function syncNode(node) {
  if (!node || node.type !== NODE_TYPE) return;
  if (!Array.isArray(node.inputs)) node.inputs = [];
  if (!Array.isArray(node.outputs)) node.outputs = [];
  hookPerInputWidget(node);
  const a = growInputs(node);
  const b = syncOutputs(node);
  const c = syncOutputWidgets(node);
  if (a || b || c) refit(node);
}

/** 延迟一拍：连线和加载工作流都是同步的一串操作，等它做完再动插槽。 */
function scheduleSync(node) {
  if (node.__ofsPending) return;
  node.__ofsPending = true;
  setTimeout(() => {
    node.__ofsPending = false;
    syncNode(node);
  }, 0);
}

app.registerExtension({
  name: "koivis.OutputFanoutSwitch",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== NODE_TYPE) return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated?.apply(this, arguments);
      syncNode(this);
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
      scheduleSync(this); // 加载工作流后对齐口数
      return r;
    };

    // 有些前端版本改下拉不触发 onWidgetChanged，这里双保险
    const onWidgetChanged = nodeType.prototype.onWidgetChanged;
    nodeType.prototype.onWidgetChanged = function (name) {
      const r = onWidgetChanged?.apply(this, arguments);
      if (name === PER_INPUT_NAME) scheduleSync(this);
      return r;
    };
  },

  nodeCreated(node) {
    if (node.type === NODE_TYPE) scheduleSync(node);
  },
});
