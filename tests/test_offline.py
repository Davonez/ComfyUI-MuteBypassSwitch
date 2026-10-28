"""离线单元测试：不需要启动 ComfyUI，直接 import nodes.py 跑逻辑。

重点验证两件事：
  1. 透传是「同一个对象引用」，且传入数据在执行前后完全没被改动；
  2. 各种 switch / route / 输入缺失组合下，选的是哪一路。
"""

from __future__ import annotations

import importlib.util
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
NODES_PY = HERE.parent / "nodes.py"

spec = importlib.util.spec_from_file_location("mbs_nodes", NODES_PY)
mod = importlib.util.module_from_spec(spec)
sys.modules["mbs_nodes"] = mod
spec.loader.exec_module(mod)

ANY = mod.ANY
Node = mod.MuteBypassSwitch
AB = mod.AnyABSwitch

ok = 0


def check(name, cond, extra=""):
    global ok
    if not cond:
        raise AssertionError(f"FAIL: {name} {extra}")
    ok += 1
    print(f"  [ok] {name}")


# ---------------------------------------------------------------- 节点定义
print("[1] 节点定义 (INPUT_TYPES)")

it = Node.INPUT_TYPES()
check("main 在 optional 里", "main" in it["optional"] and "main" not in it.get("required", {}))
check("bypass 在 optional 里", "bypass" in it["optional"] and "bypass" not in it.get("required", {}))
check("main 类型是通配 *", it["optional"]["main"][0] == "*")
check("bypass 类型是通配 *", it["optional"]["bypass"][0] == "*")
check("main 是强制输入插槽", it["optional"]["main"][1].get("forceInput") is True)
check("switch 是 BOOLEAN 且默认开", it["required"]["switch"][0] == "BOOLEAN"
      and it["required"]["switch"][1]["default"] is True)
check("route 选项齐备", list(it["required"]["route"][0]) == ["auto", "main", "bypass"])
check("输出类型也是通配 *", Node.RETURN_TYPES[0] == "*")
check("输出只有一个口", len(Node.RETURN_TYPES) == 1)
check("没有必填的链路输入", set(it.get("required", {})) == {"switch", "route"})

# 通配符在前端的连线判断：两侧都不相等（!= 必须为 False）
check('"*" != "IMAGE" 为 False', not (ANY != "IMAGE"))
check('"IMAGE" != "*" 为 False', not ("IMAGE" != ANY))
check('"*" != "LATENT" 为 False', not (ANY != "LATENT"))
check("isinstance(str) 成立", isinstance(ANY, str))
check('str(ANY) == "*"', str(ANY) == "*")

# ---------------------------------------------------------------- 数据不被改动
print("[2] 透传：同一个对象、不改数据")


class Payload:
    """带内部状态的假 tensor，记录有没有被碰过。"""

    def __init__(self, tag):
        self.tag = tag
        self.touched = False
        self.data = bytearray(b"\x01\x02\x03")


payload = Payload("main")
snapshot_tag, snapshot_bytes = payload.tag, bytes(payload.data)

out, = Node().apply(switch=True, route="auto", main=payload, bypass=Payload("bypass"),
                    unique_id=7)
check("输出就是传进去的那个对象 (is)", out is payload)
check("tag 没被改", out.tag == snapshot_tag)
check("字节内容没被改", bytes(out.data) == snapshot_bytes)
check("没有额外属性被写入", not hasattr(out, "__mbs_wrapped__") and not out.touched)

# 再验一遍 list / dict / 函数这种容易被人“顺手 copy 一下”的对象
lst = [1, 2, {"k": "v"}]
dct = {"a": [1, 2]}
fn = lambda x: x  # noqa: E731
for obj, label in ((lst, "list"), (dct, "dict"), (fn, "callable")):
    got, = Node().apply(switch=True, route="auto", main=obj, unique_id=1)
    check(f"{label} 输出 is 输入", got is obj)

# 非 None 的“假值”也必须算有值（0 / "" / False / 空 list）
for falsy in (0, "", False, [], 0.0):
    got, = Node().apply(switch=True, route="auto", main=falsy, bypass="BYPASS", unique_id=1)
    check(f"主线是假值 {falsy!r} 时仍然用主线", got is falsy)

# ---------------------------------------------------------------- 路由矩阵
print("[3] 路由矩阵 (switch / route / 输入缺失)")

M, B = "MAIN", "BYPASS"

cases = [
    # (说明, kwargs, 期望值)
    ("auto: 主线有值 -> 主线", dict(switch=True, route="auto", main=M, bypass=B), M),
    ("auto: 主线缺失 + 开关开 -> 旁路", dict(switch=True, route="auto", bypass=B), B),
    ("auto: 主线缺失 + 开关关 -> 空", dict(switch=False, route="auto", bypass=B), None),
    ("auto: 主线空 + 不接旁路 -> 空", dict(switch=True, route="auto", main=None), None),
    ("auto: 两路都空 -> 空", dict(switch=True, route="auto"), None),
    ("auto: 主线缺失 + 旁路是假值 0 -> 仍取旁路", dict(switch=True, route="auto", bypass=0), 0),
    ("force main: 主线有值 -> 主线", dict(switch=True, route="main", main=M, bypass=B), M),
    ("force main: 主线缺失 -> 空(尊重强制)", dict(switch=True, route="main", bypass=B), None),
    ("force bypass: 两路都有 -> 旁路", dict(switch=True, route="bypass", main=M, bypass=B), B),
    ("force bypass: 旁路缺失 -> 退回主线不阻断", dict(switch=True, route="bypass", main=M), M),
    ("force bypass: 旁路缺失+主线也空 -> 空", dict(switch=True, route="bypass"), None),
    ("开关关但 force bypass -> 仍走旁路(调试用)", dict(switch=False, route="bypass", main=M, bypass=B), B),
]

for desc, kwargs, expect in cases:
    got, = Node().apply(**kwargs)
    check(desc, got is expect or got == expect, f"got={got!r} expect={expect!r}")

# ComfyUI 调用方式：缺失的可选输入根本不会出现在 kwargs 里
got, = Node().apply(switch=True, route="auto")
check("只传两个控件、两个输入都没接也不崩", got is None)
got, = Node().apply(switch=True, route="auto", bypass=B)
check("只传 bypass（模拟上游静音）", got is B)
got, = Node().apply(switch=True, route="auto", main=M)
check("只传 main", got is M)

# ---------------------------------------------------------------- A/B 节点
print("[4] 任意 A/B 开关")

it2 = AB.INPUT_TYPES()
check("a/b 都是可选通配", it2["optional"]["a"][0] == "*" and it2["optional"]["b"][0] == "*")
check("A 路", AB().apply(which="A", a=M, b=B)[0] is M)
check("B 路", AB().apply(which="B", a=M, b=B)[0] is B)
check("选中 A 但 A 空 -> 退回 B", AB().apply(which="A", b=B)[0] is B)
check("两路都空 -> None", AB().apply(which="A")[0] is None)

# ---------------------------------------------------------------- 多路汇聚
print("[6] 多路汇聚开关 (MultiAnySwitch)")

MULTI = mod.MultiAnySwitch
it3 = MULTI.INPUT_TYPES()
check("input_1 / input_2 都是可选通配",
      it3["optional"]["input_1"][0] == "*" and it3["optional"]["input_2"][0] == "*")
check("没有必填的链路输入", set(it3.get("required", {})) == {"switch", "pick", "force"})
check("默认挑第一路", it3["required"]["pick"][1]["default"] == "first")

m = MULTI()


def multi(**kw):
    """模拟 ComfyUI 调用：缺失的输入不会出现在 kwargs 里。"""
    return m.apply(**{"switch": True, "pick": "first", **kw})[0]


check("只接了 input_2（等于第 1 路被静音）-> 用第 2 路", multi(input_2="B") == "B")
check("第 1、2 路都空，靠第 3 路 -> 用第 3 路",
      multi(input_3="C") == "C")
check("四路都在 -> 用第 1 路", multi(input_1="A", input_2="B", input_3="C", input_4="D") == "A")
check("第 1 路空、2/3/4 在 -> 用第 2 路",
      multi(input_2="B", input_3="C", input_4="D") == "B")
check("kwargs 顺序打乱也按插槽号排",
      multi(input_3="C", input_1="A", input_2="B") == "A")
check("input_10 要排在 input_2 后面（数字比较，不是字符串比较）",
      MULTI().apply(switch=True, pick="first", input_2="B", input_10="J")[0] == "B")
check("pick=last 时取 input_10 而不是 input_2",
      MULTI().apply(switch=True, pick="last", input_2="B", input_10="J")[0] == "J")
check("pick=last 且只有一路有值 -> 那一路", MULTI().apply(switch=True, pick="last", input_2="B")[0] == "B")
check("一路都没接 -> None", multi() is None)
check("全被静音（只传空的 None）-> None", multi(input_1=None, input_2=None) is None)
check("汇聚关掉时只认第 1 路", MULTI().apply(switch=False, pick="first", input_1="A", input_2="B")[0] == "A")
check("汇聚关掉且第 1 路空 -> None（不偷偷用第 2 路）",
      MULTI().apply(switch=False, pick="first", input_2="B")[0] is None)
check("假值 0 也算有值", multi(input_1=0, input_2="B") == 0)
check("假值空字符串也算有值", multi(input_1="", input_2="B") == "")

payload2 = Payload("multi")
got2 = MULTI().apply(switch=True, pick="first", input_2=payload2)[0]
check("多路也是同一个对象 (is)", got2 is payload2)
check("多路不透传时数据没变", payload2.tag == "multi" and bytes(payload2.data) == b"\x01\x02\x03")

check("无关的 kwargs 不影响", MULTI().apply(switch=True, pick="first", foo=1, bar="x")[0] is None)
check("名字不是 input_数字 的会被忽略", multi(input_x="?", input_2="B") == "B")
check("input_0 这种非法序号不参与", multi(input_0="Z", input_2="B") == "B")

# ---------------------------------------------------------------- 多通道
print("[7] 多通道汇聚 (MultiChannelSwitch)")

MC = mod.MultiChannelSwitch
it4 = MC.INPUT_TYPES()
check("链路输入只声明了通道 1 的两路", {k for k in it4["optional"] if not k.endswith("_force")} == {"ch1_a", "ch1_b"}, str(sorted(it4["optional"])))
check("静态声明了 8 个输出口", len(MC.RETURN_TYPES) == 8, str(len(MC.RETURN_TYPES)))
check("输出口都是通配 *", all(t == "*" for t in MC.RETURN_TYPES))
check("输出名字是 ch1..ch8", MC.RETURN_NAMES == tuple(f"ch{i}" for i in range(1, 9)))

mc = MC()


def mcout(**kw):
    return mc.apply(**{"switch": True, "pick": "first", **kw})


check("通道1 用 a", mcout(ch1_a="A1", ch1_b="B1")[0] == "A1")
check("通道1 的 a 缺失 -> 用 b", mcout(ch1_b="B1")[0] == "B1")
check("没用到的通道都是 None", mcout(ch1_a="A1")[1:] == (None,) * 7)
check("通道之间互不影响",
      mcout(ch1_a="A1", ch1_b="B1", ch2_a="A2")[:3] == ("A1", "A2", None),
      str(mcout(ch1_a="A1", ch2_a="A2")[:3]))
check("通道2 只有 b 时也能出", mcout(ch2_b="B2")[1] == "B2" and mcout(ch2_b="B2")[0] is None)
check("pick=last", mc.apply(switch=True, pick="last", ch1_a="A1", ch1_b="B1")[0] == "B1")
check("第 3 路候选 c 能用", mcout(ch1_c="C1")[0] == "C1")
check("a、b 都有值时不让 c 抢", mcout(ch1_a="A1", ch1_b="B1", ch1_c="C1")[0] == "A1")
check("第 8 通道可用", mcout(ch8_a="A8")[7] == "A8")
check("第 9 通道越界会被忽略", mcout(ch9_a="X") == (None,) * 8)
check("汇聚关掉时只认 a", mc.apply(switch=False, pick="first", ch1_a="A1", ch1_b="B1")[0] == "A1")
check("汇聚关掉且 a 空 -> None", mc.apply(switch=False, pick="first", ch1_b="B1")[0] is None)
check("返回固定 8 个值", len(mcout()) == 8)
check("无关 kwargs 不影响", mcout(foo=1, bar="x") == (None,) * 8)

payload3 = Payload("channel")
check("多通道也是同一个对象 (is)", mcout(ch1_b=payload3)[0] is payload3)
check("多通道不透传时数据没变",
      payload3.tag == "channel" and bytes(payload3.data) == b"\x01\x02\x03")

# ---------------------------------------------------------------- 强制选择
print("[8] 强制选择 (force)：自己指定走哪一路")

# 多路汇聚：force = 0 自动 / 1..N 强制第 N 路
check("多路 force 控件默认 0（自动）", it3["required"]["force"][1]["default"] == 0)
check("force=0 时行为和以前一样（自动挑）",
      MULTI().apply(switch=True, pick="first", force=0, input_1="A", input_2="B")[0] == "A")
check("force=2 时无视 input_1，强制用第 2 路",
      MULTI().apply(switch=True, pick="first", force=2, input_1="A", input_2="B")[0] == "B")
check("force=2 且第 2 路没接 -> 交空（不偷偷回退到第 1 路）",
      MULTI().apply(switch=True, pick="first", force=2, input_1="A")[0] is None)
check("force 优先于 pick=last",
      MULTI().apply(switch=True, pick="last", force=1, input_1="A", input_2="B")[0] == "A")
check("force 优先于 switch=关",
      MULTI().apply(switch=False, pick="first", force=3, input_3="C")[0] == "C")
check("force=5 但只接了 1、2 路 -> 空",
      MULTI().apply(switch=True, pick="first", force=5, input_1="A", input_2="B")[0] is None)

# 多通道：force = auto / a / b / c
check("多通道 force 控件默认 auto", it4["required"]["force"][1]["default"] == "auto")
check("多通道 force=b：所有通道都走 b（无视 a 有值）",
      mcout(ch1_a="A1", ch1_b="B1", ch2_a="A2", ch2_b="B2", force="b")[:2] == ("B1", "B2"))
check("多通道 force=a：两个通道都走 a",
      mcout(ch1_a="A1", ch1_b="B1", ch2_a="A2", ch2_b="B2", force="a")[:2] == ("A1", "A2"))
check("多通道 force=b 但某通道 b 没接 -> 那个通道交空，不回落",
      mcout(ch1_a="A1", ch1_b="B1", ch2_a="A2", force="b")[:2] == ("B1", None),
      str(mcout(ch1_a="A1", ch1_b="B1", ch2_a="A2", force="b")[:2]))
check("多通道 force 优先于 switch=关",
      mcout(ch1_a="A1", ch1_b="B1", switch=False, force="b")[0] == "B1")
check("多通道 force=c", mcout(ch1_c="C1", ch1_a="A1", force="c")[0] == "C1")
check("多通道 force 仍然只交引用", mcout(force="b", ch1_b=payload2)[0] is payload2)

# 每个通道各自的 ch{k}_force
check("8 个通道都有各自的 force 下拉",
      all(f"ch{k}_force" in it4["optional"] for k in range(1, 9)))
check("每个 ch{k}_force 默认都是 auto",
      all(it4["optional"][f"ch{k}_force"][1]["default"] == "auto" for k in range(1, 9)))
check("每通道各自强制：ch1=b、ch2=a",
      mcout(ch1_a="A1", ch1_b="B1", ch2_a="A2", ch2_b="B2",
            ch1_force="b", ch2_force="a")[:2] == ("B1", "A2"),
      str(mcout(ch1_a="A1", ch1_b="B1", ch2_a="A2", ch2_b="B2",
                ch1_force="b", ch2_force="a")[:2]))
check("通道自己的 force 优先于总 force",
      mcout(ch1_a="A1", ch1_b="B1", force="a", ch1_force="b")[0] == "B1")
check("通道 force=auto 时跟随总 force",
      mcout(ch1_a="A1", ch1_b="B1", force="b", ch1_force="auto")[0] == "B1")
check("通道强制 b 但 b 没接 -> 只有那个通道交空，别人照常",
      mcout(ch1_a="A1", ch2_a="A2", ch1_force="b")[:2] == (None, "A2"),
      str(mcout(ch1_a="A1", ch2_a="A2", ch1_force="b")[:2]))
check("通道强制 c 也能用", mcout(ch1_a="A1", ch1_c="C1", ch1_force="c")[0] == "C1")
check("通道 force 只管自己那一路（不影响别的通道的自动挑）",
      mcout(ch1_b="B1", ch2_a="A2", ch1_force="b")[:2] == ("B1", "A2"))

# ---------------------------------------------------------------- 一对多分发
print("[9] 输出分发开关 (OutputFanoutSwitch): 一个输入配几个输出")

FO = mod.OutputFanoutSwitch
it5 = FO.INPUT_TYPES()
check("静态声明了 32 个输出口（8 路输入 × 4）", len(FO.RETURN_TYPES) == 32, str(len(FO.RETURN_TYPES)))
check("输出名字 out_1..out_32", FO.RETURN_NAMES == tuple(f"out_{i}" for i in range(1, 33)))
check("链路输入只声明了 in_1",
      {k for k in it5["optional"] if not k.startswith("output_")} == {"in_1"},
      str(sorted(it5["optional"]))[:120])
check("32 个输出都有自己的 on/off 下拉",
      all(f"output_{i}" in it5["optional"] for i in range(1, 33)))
check("输出下拉只有 on / off 两个选项",
      it5["optional"]["output_1"][0] == ["on", "off"], str(it5["optional"]["output_1"][0]))
check("输出下拉默认 on", it5["optional"]["output_1"][1]["default"] == "on")
check("outputs_per_input 只有 2/3/4 三个选项",
      it5["required"]["outputs_per_input"][0] == ["2", "3", "4"],
      str(it5["required"]["outputs_per_input"][0]))
check("outputs_per_input 默认 2",
      it5["required"]["outputs_per_input"][1]["default"] == "2")

fo = FO()


def fout(**kw):
    return fo.apply(**{"outputs_per_input": "2", **kw})


check("配 2 个：1 路输入 -> 前 2 个输出有值", fout(in_1="A")[:4] == ("A", "A", None, None),
      str(fout(in_1="A")[:4]))
check("配 2 个：2 路输入 -> A、A、B、B",
      fout(in_1="A", in_2="B")[:6] == ("A", "A", "B", "B", None, None),
      str(fout(in_1="A", in_2="B")[:6]))
check("配 3 个：1 路输入 -> 前 3 个",
      fout(**{"outputs_per_input": "3"}, in_1="A")[:5] == ("A", "A", "A", None, None),
      str(fout(**{"outputs_per_input": "3"}, in_1="A")[:5]))
check("配 3 个：2 路输入 -> A A A B B B",
      fout(**{"outputs_per_input": "3"}, in_1="A", in_2="B")[:8]
      == ("A", "A", "A", "B", "B", "B", None, None),
      str(fout(**{"outputs_per_input": "3"}, in_1="A", in_2="B")[:8]))
check("配 4 个：1 路输入 -> 前 4 个",
      fout(**{"outputs_per_input": "4"}, in_1="A")[:5] == ("A", "A", "A", "A", None))
check("关掉某个输出 -> 它交空", fout(in_1="A", **{"output_2": "off"})[:3] == ("A", None, None))
check("关掉某个输出不影响别的",
      fout(in_1="A", in_2="B", **{"output_3": "off"})[:4] == ("A", "A", None, "B"))
check("第 1 路静音、第 2 路有值 -> 只有第 2 对输出有值",
      fout(in_1=None, in_2="B")[:5] == (None, None, "B", "B", None),
      str(fout(in_1=None, in_2="B")[:5]))
check("一个输入都没接 -> 全空", fout()[:4] == (None,) * 4)
check("输入是假值 0 也算有值", fout(in_1=0)[0] == 0)
check("输出的是同一个对象 (is)", fout(in_1=payload2)[0] is payload2)
check("无关 kwargs 不影响", fout(in_1="A", foo=1)[0] == "A")
check("选项写坏（比如旧的 auto）也活得下去，按 2 个处理",
      fout(**{"outputs_per_input": "auto"}, in_1="A")[:3] == ("A", "A", None))

# ---------------------------------------------------------------- 注册表
print("[10] 注册表")
check("MuteBypassSwitch 已注册", mod.NODE_CLASS_MAPPINGS["MuteBypassSwitch"] is Node)
check("AnyABSwitch 已注册", mod.NODE_CLASS_MAPPINGS["AnyABSwitch"] is AB)
check("MultiAnySwitch 已注册", mod.NODE_CLASS_MAPPINGS["MultiAnySwitch"] is MULTI)
check("MultiChannelSwitch 已注册", mod.NODE_CLASS_MAPPINGS["MultiChannelSwitch"] is MC)
check("OutputFanoutSwitch 已注册", mod.NODE_CLASS_MAPPINGS["OutputFanoutSwitch"] is FO)
check("显示名齐备",
      all(mod.NODE_DISPLAY_NAME_MAPPINGS[k] for k in mod.NODE_CLASS_MAPPINGS))
check("FUNCTION 指向真实方法",
      all(callable(getattr(c, c.FUNCTION)) for c in mod.NODE_CLASS_MAPPINGS.values()))

print(f"\n全部通过: {ok} 项")
