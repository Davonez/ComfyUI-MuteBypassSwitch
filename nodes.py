"""
静音旁路开关 (Mute Bypass Switch) —— ComfyUI 自定义节点
================================================================

要解决的问题
------------
ComfyUI 里把一个节点「静音 / 禁用」(Mute, Ctrl+M) 之后，节点不会进入执行图，
连到它输出端的那根线在执行时也随之消失。于是下游节点那个【必填输入】就没值了，
提交任务时直接报：

    Required input is missing: xxx

工作流就此卡死，没法往下跑。

引擎里的事实（对应 ComfyUI/execution.py 的 validate_inputs）：
  * 必填输入缺失 -> 报 "Required input is missing"，整体不执行；
  * 可选输入缺失 -> 直接跳过，不报错。

所以本节点的做法是：
  1. 把两个输入 main / bypass 都声明成「可选 + 任意类型(*)」，
     上游被静音时，本节点自己绝不会报缺输入；
  2. 主线 main 没值了，就把旁路 bypass 的值原样交给下游。

本节点只做「引用转交」，对数据不做任何复制、转换、打包、detach、搬 CPU 等操作，
传进去什么对象，吐出来就是同一个对象（id 都不变）。

作者: koivis / DeepSeek Harness
许可: MIT
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
    """主线被静音时自动改走旁路，数据原样透传。"""

    DESCRIPTION = (
        "透传开关：把上游数据原样交给下游，不做任何修改。"
        "两个输入都是「可选 + 任意类型」，所以上游被静音(Mute)时本节点不会报缺输入；"
        "主线缺失时自动改走旁路，避免下游 Required input is missing。"
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "switch": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "label_on": "旁路 开",
                        "label_off": "旁路 关",
                        "tooltip": "开：主线缺失时允许走旁路；关：只走主线（等于把旁路线剪断）。",
                    },
                ),
                "route": (
                    ["auto", "main", "bypass"],
                    {
                        "default": "auto",
                        "tooltip": "auto=主线优先、缺了走旁路 ｜ main=只走主线 ｜ bypass=只走旁路（调试用）",
                    },
                ),
            },
            "optional": {
                "main": (
                    ANY,
                    {
                        "forceInput": True,
                        "tooltip": "主线：来自那个有可能被你静音的节点。",
                    },
                ),
                "bypass": (
                    ANY,
                    {
                        "forceInput": True,
                        "tooltip": "旁路：主线被静音时接管的一路（通常直接接上游源头）。",
                    },
                ),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = (ANY,)
    RETURN_NAMES = ("data",)
    OUTPUT_TOOLTIPS = ("原样透传进来的那个对象。",)
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
                "节点#%s 主线输入缺失（上游大概被静音了），已改走旁路，数据原样透传。",
                unique_id,
            )
        elif source == "none":
            LOGGER.warning(
                "节点#%s 主线和旁路都没有值：主线被静音，而旁路没接（或开关是关的）。"
                "下游如果还要这个输入，就会拿不到数据。",
                unique_id,
            )

        # 关键：直接返回同一个对象引用，不 copy、不 to()、不转换成 list。
        return (value,)


class AnyABSwitch:
    """任意类型的二选一开关：A 路 / B 路，选中的那路原样输出。"""

    DESCRIPTION = (
        "任意类型 A/B 二选一：选中的那一路上有什么就原样输出什么，"
        "选中的那路没接则自动退回另一路，不会让下游因为缺输入而崩。"
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "which": (
                    ["A", "B"],
                    {"default": "A", "tooltip": "选 A 就输出 a 路，选 B 就输出 b 路。"},
                ),
            },
            "optional": {
                "a": (ANY, {"forceInput": True, "tooltip": "A 路输入。"}),
                "b": (ANY, {"forceInput": True, "tooltip": "B 路输入。"}),
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
                "节点#%s 选中的 %s 路是空的，已自动改用另一路。", unique_id, which
            )
            return (second,)

        LOGGER.warning("节点#%s A/B 两路都没有值。", unique_id)
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
    """多路任意类型汇聚：想接几路接几路，输出「有值的那一路」。"""

    DESCRIPTION = (
        "多路汇聚：可以接任意多路（任意类型）输入，输出其中有值的那一路，数据原样转交。"
        "被静音/禁用的上游不会让本节点报错，直接跳过它继续往下选；"
        "最后一路接上线后，画布会自动多出一个空输入口，可以一直加。"
        "不想自动挑？把 force 设成 3，就强制走第 3 路。"
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "switch": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "label_on": "汇聚 开",
                        "label_off": "汇聚 关",
                        "tooltip": "开：在多路里挑有值的那一路；关：只认第 1 路（等于没这个节点）。",
                    },
                ),
                "pick": (
                    ["first", "last"],
                    {
                        "default": "first",
                        "tooltip": "多路都有值时用哪一路：first=画布上最上面那路 ｜ last=最下面那路",
                    },
                ),
                "force": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": 16,
                        "step": 1,
                        "tooltip": "强制用第几路：0=自动（挑有值的那一路）；1~16=只看这一路，没值就输出空，不再自动换路。",
                    },
                ),
            },
            "optional": {
                "input_1": (
                    ANY,
                    {
                        "forceInput": True,
                        "tooltip": "第 1 路。接上以后会自动多出一个输入口，可以一直往下加。",
                    },
                ),
                "input_2": (
                    ANY,
                    {
                        "forceInput": True,
                        "tooltip": "第 2 路。第 1 路被静音时就会用这一路。",
                    },
                ),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = (ANY,)
    RETURN_NAMES = ("data",)
    OUTPUT_TOOLTIPS = ("被选中的那一路，原样透传。",)
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
                    "节点#%s 强制走第 %d 路，但这一路没有值（上游大概被静音了），按强制交空。",
                    unique_id,
                    forced,
                )
            else:
                LOGGER.info("节点#%s 强制走第 %d 路，已原样透传。", unique_id, forced)
        elif value is None:
            if switch:
                LOGGER.warning(
                    "节点#%s 汇聚到的 %d 路全都没值（都被静音，或者一路都没接），交不出数据。",
                    unique_id,
                    len(items),
                )
            else:
                LOGGER.warning("节点#%s 汇聚开关是关的，且第 1 路没值。", unique_id)
        elif index > 1 and pick == "first":
            LOGGER.info(
                "节点#%s 汇聚：前面 %d 路是空的（大概被静音了），改用第 %d 路，共 %d 路有值。",
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
    """多通道汇聚：每个通道各自挑「有值的那一路」，通道之间互不影响。"""

    DESCRIPTION = (
        "多通道汇聚：每个通道有自己的几路候选输入，各自输出「有值的那一路」，原样透传。"
        "某路上游被静音时，只有那个通道自动换到下一路，其它通道完全不受影响。"
        "通道数量自动增长：一个通道接满，就自动多出下一通道的 2 个输入口和 1 个输出口（最多 8 个通道）。"
        "不想自动挑？每个通道有各自的下拉 ch{k}_force（auto/a/b/c），也可以用一个总 force 一次全指定。"
    )

    @classmethod
    def INPUT_TYPES(cls):
        # 只声明第 1 个通道的两路；后面的通道由前端扩展按需 addInput 加出来，
        # 引擎对「没声明但被连线连上的输入」一样会解析并当 kwargs 传进来。
        optional = {}
        for letter, hint in (
            ("a", "主用口（接会被静音的那条支路）"),
            ("b", "兜底口（主用没值时接管）"),
        ):
            optional[f"ch1_{letter}"] = (
                ANY,
                {"forceInput": True, "tooltip": f"通道 1 的{hint}。接满这个通道会自动长出通道 2。"},
            )
        required = {
            "switch": (
                "BOOLEAN",
                {
                    "default": True,
                    "label_on": "汇聚 开",
                    "label_off": "汇聚 关",
                    "tooltip": "开：每个通道各自挑有值的那一路；关：只认每通道的 a 路。",
                },
            ),
            "pick": (
                ["first", "last"],
                {
                    "default": "first",
                    "tooltip": "同一通道里多路都有值时用哪一路：first=最上面的 ｜ last=最下面的",
                },
            ),
            "force": (
                ["auto", "a", "b", "c"],
                {
                    "default": "auto",
                    "tooltip": "总强制：a/b/c = 所有通道都只看这一路；auto = 交给每个通道自己的 ch{k}_force 决定。",
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
                    "tooltip": f"通道 {channel} 自己指定走哪一路：auto=跟随总 force / 自动挑；a、b、c=只看这一路，没值就交空。",
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
        f"通道 {channel} 的输出：auto 模式下是该通道第一个有值的输入；强制模式下就是被强制的那一路。"
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
                    forced_empty.append(f"通道{channel}(强制 {effective})")
                continue
            if used > 1 and pick == "first":
                LOGGER.info(
                    "节点#%s 通道%d：前面 %d 路是空的（大概被静音了），改用第 %d 路。",
                    unique_id,
                    channel,
                    used - 1,
                    used,
                )

        if forced_empty:
            LOGGER.warning(
                "节点#%s %s 这一路没有值（上游大概被静音了），按强制交空。",
                unique_id,
                "、".join(forced_empty),
            )
        elif all(value is None for value in results):
            LOGGER.warning("节点#%s 所有通道都没有值，交不出数据。", unique_id)
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
PER_INPUT_CHOICES = ["2 个", "3 个", "4 个"]
ON_OFF_CHOICES = ["开", "关"]
_FANOUT_INPUT_RE = re.compile(r"^in_(\d+)$")
_OUTPUT_ON_RE = re.compile(R"^输出(\d+)$")


def _per_input_count(value) -> int:
    """把 "3 个" 这种选项解析成数字，解析不出来就按 2 个。"""
    try:
        count = int(str(value).strip().split()[0])
    except (ValueError, IndexError):
        return 2
    return max(1, min(MAX_PER_INPUT, count))


def _paired_input(output_index: int, per_input: int) -> int:
    """第 k 个输出自动配对到第几路输入。"""
    return (output_index - 1) // per_input + 1


def _collect_fanout_inputs(kwargs: dict):
    """把 in_1 / in_2 ... 收成按序号升序的 [(序号, 值)]。"""
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
    """每个输出的 开/关：{输出号: "开"/"关"}。"""
    switches = {}
    for key, value in kwargs.items():
        match = _OUTPUT_ON_RE.match(key)
        if match:
            index = int(match.group(1))
            if 1 <= index <= MAX_OUTPUTS:
                switches[index] = value or "开"
    return switches


class OutputFanoutSwitch:
    """一对多分发：一个输入配几个输出，每个输出可以单独关掉。"""

    DESCRIPTION = (
        "一个输入配几个输出。接上第 1 路输入就出 out_1..out_n（n=「每个输入配几个输出」），"
        "再接第 2 路就多出 n 个，自动跟第 2 路。每个输出有「开/关」，想关掉哪个就关掉哪个。"
        "最多 8 路输入。不会画线的时候：输出口会自己跟着输入口长出来。"
    )

    @classmethod
    def INPUT_TYPES(cls):
        optional = {
            "in_1": (
                ANY,
                {"forceInput": True, "tooltip": "第 1 路输入。接上它就自动给你前面几个输出。"},
            ),
        }
        # 每个输出一个 开/关 下拉。放 optional：UI 里照样是下拉，
        # 手写 API 不传也不会报 "Required input is missing"。
        for index in range(1, MAX_OUTPUTS + 1):
            optional[f"输出{index}"] = (
                ON_OFF_CHOICES,
                {
                    "default": "开",
                    "tooltip": f"输出 {index}：开=照常输出 ／ 关=这个输出不要了（交空）。",
                },
            )
        return {
            "required": {
                "每个输入配几个输出": (
                    PER_INPUT_CHOICES,
                    {
                        "default": "2 个",
                        "tooltip": "一个输入对应几个输出：2 个就是 A 出 out_1/out_2、B 出 out_3/out_4 …",
                    },
                ),
            },
            "optional": optional,
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = (ANY,) * MAX_OUTPUTS
    RETURN_NAMES = tuple(f"out_{index}" for index in range(1, MAX_OUTPUTS + 1))
    OUTPUT_TOOLTIPS = tuple(
        f"输出 {index}：默认跟第 {(index - 1) // 2 + 1} 路输入（配 2 个时）。"
        for index in range(1, MAX_OUTPUTS + 1)
    )
    FUNCTION = "apply"
    CATEGORY = "Switch"
    OUTPUT_NODE = False

    def apply(self, 每个输入配几个输出: str = "2 个", unique_id=None, **kwargs):
        items = _collect_fanout_inputs(kwargs)
        switches = _collect_output_switches(kwargs)
        per_input = _per_input_count(每个输入配几个输出)
        by_index = {index: value for index, value in items}

        results = []
        empty_outputs = []
        for index in range(1, MAX_OUTPUTS + 1):
            if switches.get(index, "开") == "关":
                results.append(None)
                continue
            paired = _paired_input(index, per_input)
            value = by_index.get(paired)
            results.append(value)
            # 只有「那一路接了线、但值是空的」（上游被静音）才提示
            if value is None and paired in by_index and by_index[paired] is None:
                empty_outputs.append(index)

        if empty_outputs:
            LOGGER.warning(
                "节点#%s 输出 %s 对应的输入路没有值（上游大概被静音了），这几个输出是空的。",
                unique_id,
                "、".join(str(i) for i in empty_outputs[:8]) + ("…" if len(empty_outputs) > 8 else ""),
            )
        if not items:
            LOGGER.warning("节点#%s 一个输入都没接，输出全是空。", unique_id)
        return tuple(results)


NODE_CLASS_MAPPINGS = {
    "MuteBypassSwitch": MuteBypassSwitch,
    "AnyABSwitch": AnyABSwitch,
    "MultiAnySwitch": MultiAnySwitch,
    "MultiChannelSwitch": MultiChannelSwitch,
    "OutputFanoutSwitch": OutputFanoutSwitch,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MuteBypassSwitch": "静音旁路开关 (Mute Bypass Switch)",
    "AnyABSwitch": "任意 A/B 开关 (Any A/B Switch)",
    "MultiAnySwitch": "多路汇聚开关 (Multi Any Switch)",
    "MultiChannelSwitch": "多通道汇聚开关 (Multi Channel Switch)",
    "OutputFanoutSwitch": "输出分发开关 (Output Fanout Switch)",
}
