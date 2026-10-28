/**
 * 多路汇聚开关 (Multi Any Switch) —— 前端扩展
 * =====================================================================
 * 后端只在 INPUT_TYPES 里声明了 input_1 / input_2 两个口，剩下的口全靠这里"按需长出来"：
 *
 *   * 最后一路接上线  -> 自动再多出一个空输入口（想接几路接几路，上限 32）
 *   * 右键菜单        -> 手动「增加一路 / 删掉最后一路空口 / 整理空输入口」
 *
 * 为什么只加不自动减：
 *   工作流被重新加载时，前端会按保存的 inputs 数组还原插槽。如果这里在还原过程中
 *   按"当前已连线"去裁剪，很容易把还没还原完线的插槽删掉，导致连线丢失。所以自动流程
 *   只加不减，删减交给右键菜单手动做 —— 安全、可预期。
 *
 * 后端为什么能吃下这些没声明的口：
 *   ComfyUI 执行器 execution.py 的 get_input_data() 里，只要值是"连线"(is_link)，
 *   不管这个输入有没有在 INPUT_TYPES 里声明，都会解析出来当 kwargs 传给节点函数。
 */

import { app } from "../../scripts/app.js";

const NODE_TYPE = "MultiAnySwitch";
const MIN_SLOTS = 2;
const MAX_SLOTS = 32;

const nameOf = (i) => `input_${i}`;
const indexOf = (name) => {
  const m = /^input_(\d+)$/.exec(String(name ?? ""));
  return m ? Number(m[1]) : -1;
};

/**
 * 新版前端会把「控件」也作为一种 input 塞进 node.inputs
 * （所以 node.inputs 里除了 input_1 还有 switch / pick 这种 COMBO、BOOLEAN 项）。
 * 这里只数真正的输入口 input_N。
 */
function socketCount(node) {
  return (node.inputs ?? []).filter((s) => indexOf(s?.name) > 0).length;
}

/** 画布上"最靠下的那一路已连线"的序号（1 起算），没连线返回 0。 */
function lastLinked(node) {
  let last = 0;
  for (const slot of node.inputs ?? []) {
    const i = indexOf(slot?.name);
    if (i > 0 && slot.link != null) last = Math.max(last, i);
  }
  return last;
}

/**
 * 新插一个 input_N。
 *
 * 这里故意「只追加到末尾」，不把口挪到控件上方 —— 原因：
 *   前端加载工作流时，是按「先按节点定义建 input_1/input_2 和控件行，再把保存的多余口
 *   追加到末尾」来重建插槽的；graph.links 里的 target_slot 又是数组下标。
 *   一旦我们在别处重排了插槽，下标就和保存的 JSON 对不上，线会接到别的口上。
 *   所以：布局永远保持"声明口 + 控件 + 追加口"，只追加、不重排，存盘加载才不会坏。
 */
function addSocket(node, name) {
  const before = node.inputs.length;
  node.addInput(name, "*");
  return node.inputs.length === before + 1;
}

function refit(node) {
  try {
    const size = node.computeSize();
    node.setSize([Math.max(node.size?.[0] ?? size[0], size[0]), size[1]]);
    app.graph.setDirtyCanvas(true, false);
  } catch (e) {
    /* 尺寸算不出来就算了，不影响功能 */
  }
}

/** 保证「已连线的最后一路 + 1 个空口」，只加不删。 */
function growSlots(node) {
  if (!node || node.type !== NODE_TYPE) return;
  if (!Array.isArray(node.inputs)) node.inputs = [];

  const want = Math.min(MAX_SLOTS, Math.max(MIN_SLOTS, lastLinked(node) + 1));
  let changed = false;
  for (let i = socketCount(node) + 1; i <= want; i++) {
    if (!addSocket(node, nameOf(i))) break;
    changed = true;
  }
  if (changed) refit(node);
}

/** 手动整理：删掉「已连线的最后一路」之后的空口，只留一个空位。 */
function trimSlots(node) {
  if (!node || node.type !== NODE_TYPE) return;
  const keep = Math.min(MAX_SLOTS, Math.max(MIN_SLOTS, lastLinked(node) + 1));
  let changed = false;
  while (socketCount(node) > keep) {
    const pos = node.inputs.length - 1;
    const slot = node.inputs[pos];
    if (!slot || indexOf(slot.name) < 0 || slot.link != null) break; // 只删末尾的、没连线的口
    try {
      node.removeInput(pos);
      changed = true;
    } catch (e) {
      break;
    }
  }
  if (changed) {
    refit(node);
    app.graph.afterChange?.();
  }
}

/**
 * 延迟一拍再同步：连线/加载工作流是同步的一串操作，等这一串做完再动插槽，
 * 避免在"线还没还原完"的中间状态里插入槽位。
 */
function scheduleGrow(node) {
  if (node.__mbsPending) return;
  node.__mbsPending = true;
  setTimeout(() => {
    node.__mbsPending = false;
    growSlots(node);
  }, 0);
}

/** 右键菜单用：手动加一路空口（还没接线也能加）。 */
function addOneSlot(node) {
  if (!node || node.type !== NODE_TYPE) return;
  const next = socketCount(node) + 1;
  if (next > MAX_SLOTS) return;
  if (addSocket(node, nameOf(next))) {
    refit(node);
    app.graph.afterChange?.();
  }
}

/** 右键菜单用：删掉最后一路空口（只删动态加的、且没连线的口）。 */
function removeOneSlot(node) {
  if (!node || node.type !== NODE_TYPE) return;
  for (let i = node.inputs.length - 1; i >= 0; i--) {
    const slot = node.inputs[i];
    if (indexOf(slot?.name) <= MIN_SLOTS) return; // input_1 / input_2 是声明口，不动
    if (slot.link != null) return; // 有线的口不删
    try {
      node.removeInput(i);
    } catch (e) {
      return;
    }
    refit(node);
    app.graph.afterChange?.();
    return;
  }
}

app.registerExtension({
  name: "koivis.MultiAnySwitch",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== NODE_TYPE) return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated?.apply(this, arguments);
      growSlots(this);
      return r;
    };

    const onConnectionsChange = nodeType.prototype.onConnectionsChange;
    nodeType.prototype.onConnectionsChange = function (type) {
      const r = onConnectionsChange?.apply(this, arguments);
      if (type === 1) scheduleGrow(this); // 1 = 输入插槽发生变化
      return r;
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const r = onConfigure?.apply(this, arguments);
      scheduleGrow(this); // 加载工作流之后补齐空口
      return r;
    };

    const getExtraMenuOptions = nodeType.prototype.getExtraMenuOptions;
    nodeType.prototype.getExtraMenuOptions = function (canvas, options) {
      const r = getExtraMenuOptions?.apply(this, arguments);
      if (Array.isArray(options)) {
        options.push(
          null,
          {
            content: "+ Add one input slot",
            callback: () => addOneSlot(this),
          },
          {
            content: "- Remove the last empty slot",
            callback: () => removeOneSlot(this),
          },
          {
            content: "Tidy empty input slots (keep connected + 1 spare)",
            callback: () => trimSlots(this),
          },
        );
      }
      return r;
    };
  },

  // 兜底：节点建好后如果插槽数不对（少数情况下 onNodeCreated 时机不对），再补一次
  nodeCreated(node) {
    if (node.type === NODE_TYPE) scheduleGrow(node);
  },
});
