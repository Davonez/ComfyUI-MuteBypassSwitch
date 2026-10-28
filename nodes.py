"""
Mute Bypass Switch for ComfyUI
================================================================

The problem
-----------
When a node is muted / disabled in ComfyUI (Ctrl+M) it is dropped from the
execution graph, and the link coming out of it is dropped too. A downstream
node that declares that link as a *required* input then fails at submit time:

    Required input is missing: xxx

and the workflow stops there.

What this pack does
-------------------
1. The pass-through nodes declare their link inputs as optional and of type
   "*", so a muted upstream can never trigger a missing-input error here.
2. When the main link disappears, the bypass link is handed downstream
   instead.

Data is only passed by reference: nothing is copied, converted, detached or
moved to another device.

Nodes:
  * MuteBypassSwitch    - main/bypass pair, falls back to bypass when main is gone
  * AnyABSwitch         - arbitrary-type A/B selector
  * MultiAnySwitch      - auto-growing merge, outputs the slot that has a value
  * MultiChannelSwitch  - per-channel merge, channels grow on demand
  * OutputFanoutSwitch  - one input to N outputs, each output switchable

Author: koivis / DeepSeek Harness
License: MIT
"""

from __future__ import annotations

import logging
import re

__all__ = [
    "ANY",
    "MuteBypassSwitch",
    "AnyABSwitch",
    "MultiAnySwitch",
    "MultiChannelSwitch",
    "OutputFanoutSwitch",
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
]

# ComfyUI 自带日志配置，这里只取一个具名 logger，会跟着根 logger 输出到控制台。
LOGGER = logging.getLogger("comfyui.mutebypassswitch")
LOGGER.setLevel(logging.INFO)


class _AnyType(str):
    """通配类型 "*"。

    ComfyUI 前端判断两个插槽能否连线时，用的是 ``received != input_type``
    这种不等比较（LiteGraph 的 isValidConnection 一路传下来）。把 __ne__ 恒定
    返回 False，就能让任意类型连到本节点的输入，也允许本节点的输出连到任意输入。

    后端 comfy_execution/validation.py 里同样把 "*"（IO.AnyType.io_type）
    视作 Any 放行，两边都不会拦。
    """

    def __ne__(self, other: object) -> bool:  # noqa: D105  (故意恒为 False)
        return False

    def __repr__(self) -> str:  # 让 print/日志 看着舒服，不影响 str 行为
        return "'*'"


ANY = _AnyType("*")


def _resolve_route(main, bypass, switch, route):
    """决定这次到底把哪一路交出去。

    返回 (要输出的值, 来源标记)。来源标记只用于控制台日志，不参与执行。

    规则（优先级从上到下）：
      route == "main"    -> 只用主线（哪怕它是空的，也不动旁路）
      route == "bypass"  -> 只用旁路；旁路也没接时退回主线，绝不阻断
      route == "auto"    -> 主线有值就主线；主线没值且开关打开才走旁路
    剩下的情况（主线空、旁路关 / 旁路也空）就是 None，恢复成“没有开关时”的原样。
    """
    has_main = main is not None
    has_bypass = bypass is not None

    if route == "main":
        return main, "main(force)"

    if route == "bypass":
        if has_bypass:
            return bypass, "bypass(force)"
        return main, "main(force-bypass-empty)"

    # auto
    if has_main:
        return main, "main"
    if switch and has_bypass:
        return bypass, "bypass(auto)"
    return None, "none"


class MuteBypassSwitch:
    """Falls back to the bypass link when the main link is muted. Pass-through only."""

    DESCRIPTION = (
        "Pass-through switch: hands the upstream value to the downstream node unchanged. "
        "Both inputs are optional and accept any type, so muting the upstream node never "
        "raises a missing-input error here. When the main link disappears the bypass link "
        "takes over, which avoids 'Required input is missing' downstream."
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "switch": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "label_on": "Bypass on",
                        "label_off": "Bypass off",
                        "tooltip": "On: fall back to the bypass link when main is missing. "
                        "Off: main only (the bypass link is ignored).",
                    },
                ),
                "route": (
                    ["auto", "main", "bypass"],
                    {
                        "default": "auto",
                        "tooltip": "auto = prefer main, fall back to bypass when main is missing | "
                        "main = main only | bypass = bypass only (for debugging).",
                    },
                ),
            },
            "optional": {
                "main": (
                    ANY,
                    {
                        "forceInput": True,
                        "tooltip": "Main link: the one whose upstream node may get muted.",
                    },
                ),
                "bypass": (
                    ANY,
                    {
                        "forceInput": True,
                        "tooltip": "Bypass link: takes over when main is muted (usually wired "
                        "straight to the upstream source).",
                    },
                ),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = (ANY,)
    RETURN_NAMES = ("data",)
    OUTPUT_TOOLTIPS = ("The exact same object that came in, passed through unchanged.",)
    FUNCTION = "apply"
    CATEGORY = "Switch"
    OUTPUT_NODE = False

    def apply(
        self,
        switch: bool = True,
        route: str = "auto",
        main=None,
        bypass=None,
        unique_id=None,
    ):
        value, source = _resolve_route(main, bypass, switch, route)

        if source == "bypass(auto)" or source == "main(force-bypass-empty)":
            LOGGER.info(
                "Node #%s: main input is missing (the upstream node is probably muted); "
                "switched to the bypass link and passed the data through unchanged.",
                unique_id,
            )
        elif source == "none":
            LOGGER.warning(
                "Node #%s: neither main nor bypass carries a value: main is muted and "
                "bypass is not connected (or the switch is off). Downstream will get no data "
                "for this input.",
                unique_id,
            )

        # 关键：直接返回同一个对象引用，不 copy、不 to()、不转换成 list。
        return (value,)


class AnyABSwitch:
    """Arbitrary-type A/B selector: outputs the selected link unchanged."""

    DESCRIPTION = (
        "Arbitrary-type A/B selector: outputs whatever the selected link carries, unchanged. "
        "If the selected link is not connected it falls back to the other link instead of "
        "breaking the downstream node."
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "which": (
                    ["A", "B"],
                    {"default": "A", "tooltip": "A outputs link a, B outputs link b."},
                ),
            },
            "optional": {
                "a": (ANY, {"forceInput": True, "tooltip": "Link A input."}),
                "b": (ANY, {"forceInput": True, "tooltip": "Link B input."}),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = (ANY,)
    RETURN_NAMES = ("data",)
    FUNCTION = "apply"
    CATEGORY = "Switch"
    OUTPUT_NODE = False

    def apply(self, which: str = "A", a=None, b=None, unique_id=None):
        first, second = (a, b) if which == "A" else (b, a)

        if first is not None:
            return (first,)
        if second is not None:
            LOGGER.info(
                "Node #%s: the selected link %s is empty, using the other link instead.",
                unique_id,
                which,
            )
            return (second,)

        LOGGER.warning("Node #%s: both A and B links are empty.", unique_id)
        return (None,)


_INPUT_NAME_RE = re.compile(r"^input_(\d+)$")


def _collect_inputs(kwargs: dict):
    """把 input_1 / input_2 / input_3 ... 收集成按序号升序的 [(序号, 值)]。

    为什么要按名字里的数字排序：kwargs 的顺序跟着 prompt 里 JSON 的键序走，
    不保证等于画布上从上到下的插槽顺序；而且 input_10 必须排在 input_2 后面，
    所以排序用 int() 而不是字符串比较。
    """
    items = []
    for key, value in kwargs.items():
        match = _INPUT_NAME_RE.match(key)
        if match:
            index = int(match.group(1))
            if index >= 1:  # 插槽按 1 起算，input_0 这种手工写错的不参与
                items.append((index, value))
    items.sort(key=lambda item: item[0])
    return items


def _resolve_multi(items, switch, pick, force=0):
    """多路汇聚的选路逻辑。返回 (选中的值, 第几路, 有值的有几路)。

    force > 0 时是「强制模式」：只认第 force 路，有值就用、没值就交空，
    **不再自动换路** —— 这是手动指定，不是兜底。
    """
    if force:
        for index, value in items:
            if index == int(force):
                return (value, int(force), 1)
        return (None, int(force), 0)

    if not switch:
        # 关掉汇聚：只认第 1 路，等价于“没有这个节点”
        for index, value in items:
            if index == 1:
                return (value, 1, 0)
        return (None, 0, 0)

    live = [(index, value) for index, value in items if value is not None]
    if not live:
        return (None, 0, 0)

    index, value = live[-1] if pick == "last" else live[0]
    return (value, index, len(live))


class MultiAnySwitch:
    """Arbitrary-type merge: connect as many links as you like, output the one with a value."""

    DESCRIPTION = (
        "Multi-input merge: connect any number of links of any type and output the one that "
        "carries a value, unchanged. Muted/disabled upstreams are skipped instead of raising "
        "an error. A new empty input slot appears as soon as the last one is connected, so you "
        "can keep adding links. Want a fixed slot? Set force to 3 to always use slot 3."
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "switch": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "label_on": "Merge on",
                        "label_off": "Merge off",
                        "tooltip": "On: pick the first (or last) link that carries a value. "
                        "Off: only slot 1 is used, as if this node were not there.",
                    },
                ),
                "pick": (
                    ["first", "last"],
                    {
                        "default": "first",
                        "tooltip": "Which link wins when several carry a value: "
                        "first = topmost | last = bottommost.",
                    },
                ),
                "force": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": 16,
                        "step": 1,
                        "tooltip": "Force one slot: 0 = auto (pick the link with a value); "
                        "1-16 = only that slot, output empty when it has no value (no automatic fallback).",
                    },
                ),
            },
            "optional": {
                "input_1": (
                    ANY,
                    {
                        "forceInput": True,
                        "tooltip": "Slot 1. Connecting it adds another input slot automatically; "
                        "keep adding as many as you need.",
                    },
                ),
                "input_2": (
                    ANY,
                    {
                        "forceInput": True,
                        "tooltip": "Slot 2. Used when slot 1 is muted.",
                    },
                ),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = (ANY,)
    RETURN_NAMES = ("data",)
    OUTPUT_TOOLTIPS = ("The selected link, passed through unchanged.",)
    FUNCTION = "apply"
    CATEGORY = "Switch"
    OUTPUT_NODE = False

    def apply(self, switch: bool = True, pick: str = "first", force: int = 0, unique_id=None, **kwargs):
        items = _collect_inputs(kwargs)
        forced = int(force) if force else 0
        value, index, live_count = _resolve_multi(items, switch, pick, forced)

        if forced:
            # 强制模式：只报“这一路有没有值”，不再提别的路
            if value is None:
                LOGGER.warning(
                    "Node #%s: forced slot %d has no value (its upstream is probably muted); "
                    "outputting empty as forced.",
                    unique_id,
                    forced,
                )
            else:
                LOGGER.info("Node #%s: forced slot %d, passed through unchanged.", unique_id, forced)
        elif value is None:
            if switch:
                LOGGER.warning(
                    "Node #%s: all %d merged links are empty (all muted, or none connected); "
                "nothing to output.",
                    unique_id,
                    len(items),
                )
            else:
                LOGGER.warning("Node #%s: merge switch is off and slot 1 has no value.", unique_id)
        elif index > 1 and pick == "first":
            LOGGER.info(
                "Node #%s: the first %d link(s) are empty (probably muted), using slot %d; "
                "%d link(s) carry a value.",
                unique_id,
                index - 1,
                index,
                live_count,
            )

        # 同样只交引用，不动数据。
        return (value,)


# ---------------------------------------------------------------- 多通道汇聚
# 输出口数量必须静态声明（引擎的 RETURN_TYPES 不支持动态长），所以这里一次声明 8 个，
# 画布上实际显示几个通道由前端扩展决定：默认 1 个通道（2 路候选 + 1 个输出），
# 这个通道接满了就自动长出下一通道的 2 个输入口和 1 个输出口。
MAX_CHANNELS = 8
_CHANNEL_INPUT_RE = re.compile(r"^ch(\d+)_([a-z])$")
_CHANNEL_FORCE_RE = re.compile(r"^ch(\d+)_force$")


def _collect_channels(kwargs: dict):
    """把 ch1_a / ch1_b / ch2_a ... 收成 {通道号: [(字母, 值), ...]}，通道内按字母排序。"""
    grouped = {}
    for key, value in kwargs.items():
        match = _CHANNEL_INPUT_RE.match(key)
        if not match:
            continue
        channel = int(match.group(1))
        if 1 <= channel <= MAX_CHANNELS:
            grouped.setdefault(channel, []).append((match.group(2), value))
    for candidates in grouped.values():
        candidates.sort(key=lambda item: item[0])
    return grouped


def _collect_channel_forces(kwargs: dict):
    """每个通道各自的强制选择：{通道号: "auto"/"a"/"b"/"c"}。"""
    forces = {}
    for key, value in kwargs.items():
        match = _CHANNEL_FORCE_RE.match(key)
        if match:
            channel = int(match.group(1))
            if 1 <= channel <= MAX_CHANNELS:
                forces[channel] = value or "auto"
    return forces


def _resolve_channel(candidates, switch, pick, force="auto"):
    """单个通道的选路逻辑。返回 (值, 用了第几路(1 起算), 有值的有几路)。

    force 不是 "auto" 时是「强制模式」：每个通道都只看这一路，
    有值就用、没值就交空，**不再自动换路**。
    """
    if force and force != "auto":
        for pos, (letter, value) in enumerate(candidates):
            if letter == force:
                return (value, pos + 1, 1)
        return (None, 0, 0)

    if not switch:
        # 总开关关掉：每个通道只认 a 路，等价于“没有这个节点”
        for letter, value in candidates:
            if letter == "a":
                return (value, 1, 0)
        return (None, 0, 0)

    live = [(pos + 1, value) for pos, (_letter, value) in enumerate(candidates) if value is not None]
    if not live:
        return (None, 0, 0)
    index, value = live[-1] if pick == "last" else live[0]
    return (value, index, len(live))


class MultiChannelSwitch:
    """Per-channel merge: each channel picks the link that carries a value, independently."""

    DESCRIPTION = (
        "Multi-channel merge: each channel has its own candidate links and outputs the one "
        "that carries a value, unchanged. Muting an upstream only affects that channel, which "
        "falls back on its own; every other channel is untouched. Channels grow automatically: "
        "when one is full, the next channel's 2 inputs and 1 output appear (up to 8 channels). "
        "Each channel has its own ch{k}_force dropdown (auto/a/b/c), or use the global force to "
        "set them all at once."
    )

    @classmethod
    def INPUT_TYPES(cls):
        # 只声明第 1 个通道的两路；后面的通道由前端扩展按需 addInput 加出来，
        # 引擎对「没声明但被连线连上的输入」一样会解析并当 kwargs 传进来。
        optional = {}
        for letter, hint in (
            ("a", "main input (wire the branch that may get muted)"),
            ("b", "fallback input (takes over when main is missing)"),
        ):
            optional[f"ch1_{letter}"] = (
                ANY,
                {"forceInput": True, "tooltip": f"Channel 1 {hint}. Filling this channel adds "
                "channel 2 automatically."},
            )
        required = {
            "switch": (
                "BOOLEAN",
                {
                    "default": True,
                    "label_on": "Merge on",
                    "label_off": "Merge off",
                    "tooltip": "On: each channel picks the link that carries a value. "
                    "Off: each channel uses input a only.",
                },
            ),
            "pick": (
                ["first", "last"],
                {
                    "default": "first",
                    "tooltip": "Which candidate wins inside a channel when several carry a value: "
                    "first = topmost | last = bottommost.",
                },
            ),
            "force": (
                ["auto", "a", "b", "c"],
                {
                    "default": "auto",
                    "tooltip": "Global force: a/b/c = every channel uses only that input; "
                    "auto = each channel follows its own ch{k}_force.",
                },
            ),
        }
        # 每个通道各自一个强制选择（前端会把没长出来的通道那几行折叠掉）。
        # 放在 optional 里：UI 里照样是下拉，但手写 API / 老工作流不传这些值时
        # 不会报 "Required input is missing"，缺了就按 auto 处理。
        for channel in range(1, MAX_CHANNELS + 1):
            optional[f"ch{channel}_force"] = (
                ["auto", "a", "b", "c"],
                {
                    "default": "auto",
                    "tooltip": f"Channel {channel} routing: auto = follow the global force or pick "
                    f"automatically; a, b, c = only that input, output empty when it has no value.",
                },
            )

        return {
            "required": required,
            "optional": optional,
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = (ANY,) * MAX_CHANNELS
    RETURN_NAMES = tuple(f"ch{channel}" for channel in range(1, MAX_CHANNELS + 1))
    OUTPUT_TOOLTIPS = tuple(
        f"Channel {channel} output: in auto mode the first input of this channel that carries "
        f"a value; with a forced route, the forced input."
        for channel in range(1, MAX_CHANNELS + 1)
    )
    FUNCTION = "apply"
    CATEGORY = "Switch"
    OUTPUT_NODE = False

    def apply(self, switch: bool = True, pick: str = "first", force: str = "auto", unique_id=None, **kwargs):
        grouped = _collect_channels(kwargs)
        per_channel = _collect_channel_forces(kwargs)
        global_force = force or "auto"
        results = []
        forced_empty = []

        for channel in range(1, MAX_CHANNELS + 1):
            own = per_channel.get(channel, "auto") or "auto"
            # 优先级：通道自己指定 > 总 force > 自动挑
            effective = own if own != "auto" else global_force
            value, used, _live = _resolve_channel(grouped.get(channel, []), switch, pick, effective)
            results.append(value)

            if effective != "auto":
                # 强制模式下不解释“为什么换路”（因为不会换），只记下没值的
                if value is None and grouped.get(channel):
                    forced_empty.append(f"channel {channel} (forced {effective})")
                continue
            if used > 1 and pick == "first":
                LOGGER.info(
                    "Node #%s channel %d: the first %d link(s) are empty (probably muted), "
                    "using slot %d.",
                    unique_id,
                    channel,
                    used - 1,
                    used,
                )

        if forced_empty:
            LOGGER.warning(
                "Node #%s: %s has no value (the upstream is probably muted); outputting empty "
                "as forced.",
                unique_id,
                ", ".join(forced_empty),
            )
        elif all(value is None for value in results):
            LOGGER.warning("Node #%s: no channel has a value; nothing to output.", unique_id)
        return tuple(results)


# ---------------------------------------------------------------- 一对多分发
# 新手友好版：只有两个控件。
#   1) 「每个输入配几个输出」：2 个 / 3 个 / 4 个
#   2) 每个输出一个「开 / 关」
# 输出跟哪个输入是**自动配对**的，不用选：
#   配 2 个时：out_1/out_2 跟 in_1，out_3/out_4 跟 in_2 …
#   配 3 个时：out_1..out_3 跟 in_1，out_4..out_6 跟 in_2 …
MAX_INPUTS = 8
MAX_PER_INPUT = 4
MAX_OUTPUTS = MAX_INPUTS * MAX_PER_INPUT
PER_INPUT_CHOICES = ["2", "3", "4"]
ON_OFF_CHOICES = ["on", "off"]
_FANOUT_INPUT_RE = re.compile(r"^in_(\d+)$")
_OUTPUT_ON_RE = re.compile(r"^output_(\d+)$")
_ON_OFF_ALIASES = {"on": "on", "off": "off", "开": "on", "关": "off"}


def _per_input_count(value) -> int:
    """Parse an option such as "3" (legacy "3 个" also works); fall back to 2."""
    try:
        count = int(str(value).strip().split()[0])
    except (ValueError, IndexError):
        return 2
    return max(1, min(MAX_PER_INPUT, count))


def _paired_input(output_index: int, per_input: int) -> int:
    """Which input the k-th output is paired with."""
    return (output_index - 1) // per_input + 1


def _collect_fanout_inputs(kwargs: dict):
    """Collect in_1 / in_2 ... into [(index, value)] sorted by index."""
    items = []
    for key, value in kwargs.items():
        match = _FANOUT_INPUT_RE.match(key)
        if match:
            index = int(match.group(1))
            if 1 <= index <= MAX_INPUTS:
                items.append((index, value))
    items.sort(key=lambda item: item[0])
    return items


def _collect_output_switches(kwargs: dict):
    """Collect output_1 / output_2 ... on/off switches into {output index: "on"/"off"}."""
    switches = {}
    for key, value in kwargs.items():
        match = _OUTPUT_ON_RE.match(key)
        if match:
            index = int(match.group(1))
            if 1 <= index <= MAX_OUTPUTS:
                switches[index] = _ON_OFF_ALIASES.get(str(value or "on").strip(), "on")
    return switches


class OutputFanoutSwitch:
    """One input to N outputs; every output can be switched off individually."""

    DESCRIPTION = (
        "One input to N outputs. Connecting input 1 creates out_1..out_n "
        "(n = outputs per input); connecting input 2 adds n more, paired with input 2. "
        "Every output has an on/off switch. Up to 8 inputs; output slots grow automatically "
        "as inputs are connected."
    )

    @classmethod
    def INPUT_TYPES(cls):
        optional = {
            "in_1": (
                ANY,
                {"forceInput": True, "tooltip": "Input 1. Connecting it creates the first "
                "outputs automatically."},
            ),
        }
        # One on/off dropdown per output. Kept optional: it still renders as a dropdown,
        # while hand-written API prompts that omit it do not raise "Required input is missing".
        for index in range(1, MAX_OUTPUTS + 1):
            optional[f"output_{index}"] = (
                ON_OFF_CHOICES,
                {
                    "default": "on",
                    "tooltip": f"Output {index}: on = pass the value through / "
                    f"off = disable this output (empty).",
                },
            )
        return {
            "required": {
                "outputs_per_input": (
                    PER_INPUT_CHOICES,
                    {
                        "default": "2",
                        "tooltip": "How many outputs one input gets: 2 means A drives "
                        "out_1/out_2, B drives out_3/out_4, ...",
                    },
                ),
            },
            "optional": optional,
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = (ANY,) * MAX_OUTPUTS
    RETURN_NAMES = tuple(f"out_{index}" for index in range(1, MAX_OUTPUTS + 1))
    OUTPUT_TOOLTIPS = tuple(
        f"Output {index}: paired with input {(index - 1) // 2 + 1} by default "
        f"(with 2 outputs per input)."
        for index in range(1, MAX_OUTPUTS + 1)
    )
    FUNCTION = "apply"
    CATEGORY = "Switch"
    OUTPUT_NODE = False

    def apply(self, outputs_per_input: str = "2", unique_id=None, **kwargs):
        items = _collect_fanout_inputs(kwargs)
        switches = _collect_output_switches(kwargs)
        per_input = _per_input_count(outputs_per_input)
        by_index = {index: value for index, value in items}

        results = []
        empty_outputs = []
        for index in range(1, MAX_OUTPUTS + 1):
            if switches.get(index, "on") == "off":
                results.append(None)
                continue
            paired = _paired_input(index, per_input)
            value = by_index.get(paired)
            results.append(value)
            # Only warn when that input is wired but empty (upstream muted).
            if value is None and paired in by_index and by_index[paired] is None:
                empty_outputs.append(index)

        if empty_outputs:
            LOGGER.warning(
                "Node #%s: the input paired with output(s) %s has no value (the upstream is "
                "probably muted); those outputs are empty.",
                unique_id,
                ", ".join(str(i) for i in empty_outputs[:8])
                + ("..." if len(empty_outputs) > 8 else ""),
            )
        if not items:
            LOGGER.warning("Node #%s: no input is connected, all outputs are empty.", unique_id)
        return tuple(results)


NODE_CLASS_MAPPINGS = {
    "MuteBypassSwitch": MuteBypassSwitch,
    "AnyABSwitch": AnyABSwitch,
    "MultiAnySwitch": MultiAnySwitch,
    "MultiChannelSwitch": MultiChannelSwitch,
    "OutputFanoutSwitch": OutputFanoutSwitch,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MuteBypassSwitch": "Mute Bypass Switch",
    "AnyABSwitch": "Any A/B Switch",
    "MultiAnySwitch": "Multi Any Switch",
    "MultiChannelSwitch": "Multi Channel Switch",
    "OutputFanoutSwitch": "Output Fanout Switch",
}
