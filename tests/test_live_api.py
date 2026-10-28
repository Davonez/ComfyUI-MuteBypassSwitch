"""真机验证：往运行中的 ComfyUI (127.0.0.1:8188) 提交 API 任务，检验开关是否真的救了链路。

为什么用「不写 main 这个输入」来模拟静音：
  在真实前端里 Ctrl+M 静音一个节点后，它的输出线不会出现在提交给后端的 prompt 里，
  也就是下游节点 inputs 里干脆没有这个 key —— 和这里的手写 API 完全一样。

验证的能力：
  A. main 缺失（=上游被静音） + bypass 有值 -> 下游拿到 bypass 的数据，任务成功
  B. main 有值                          -> 仍然走 main（优先级正确，行为没变）
  C. switch = 关 + main 缺失            -> 恢复原样：任务失败（说明开关真的能控制）
  D. route = bypass + 两路都有值         -> 走 bypass
  E. 两路都缺                            -> 任务报错，但错误不是 "Required input is missing"
"""

import json
import sys
import time
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:8188"
OUTPUT_ROOT = r"D:\comfyui\ComfyUI-aki-v3\ComfyUI\output"

RED = 0xFF0000
BLUE = 0x0000FF
GREEN = 0x00FF00
WHITE = 0xFFFFFF
GRAY = 0x808080

# 多路汇聚用例里，4 路各用一个不同的尺寸+颜色，光看产物就能知道用了哪一路
ROUTES = {
    1: (32, RED),
    2: (48, GREEN),
    3: (64, BLUE),
    4: (80, WHITE),
}

results = []


def post_prompt(prompt):
    body = json.dumps({"prompt": prompt, "client_id": "mbs-live-test"}).encode()
    req = urllib.request.Request(BASE + "/prompt", data=body,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r), None
    except urllib.error.HTTPError as e:
        return None, json.loads(e.read().decode("utf-8", "replace"))


def wait_history(pid, timeout=120):
    deadline = time.time() + timeout
    while time.time() < deadline:
        with urllib.request.urlopen(BASE + "/history/" + pid, timeout=15) as r:
            h = json.load(r)
        if pid in h:
            return h[pid]
        time.sleep(0.4)
    raise TimeoutError(pid)


def pixel_of(image_info):
    """读回生成的 png，返回 (宽, 高, 中心像素 RGB)。没装 PIL 就返回 None。"""
    try:
        from PIL import Image
    except ImportError:
        return None
    import os
    path = os.path.join(OUTPUT_ROOT, image_info.get("subfolder", ""), image_info["filename"])
    with Image.open(path) as im:
        w, h = im.size
        return w, h, im.convert("RGB").getpixel((w // 2, h // 2))


def base_graph(switch, route, with_main, with_bypass, prefix):
    """上游 EmptyImage(红) 当旁路；另一个 EmptyImage(蓝) 当主线。"""
    g = {
        "1": {"class_type": "EmptyImage",
              "inputs": {"width": 64, "height": 64, "batch_size": 1, "color": RED}},
        "2": {"class_type": "EmptyImage",
              "inputs": {"width": 64, "height": 64, "batch_size": 1, "color": BLUE}},
        "10": {"class_type": "MuteBypassSwitch",
               "inputs": {"switch": switch, "route": route}},
        "20": {"class_type": "SaveImage",
               "inputs": {"images": ["10", 0], "filename_prefix": prefix}},
    }
    if with_main:
        g["10"]["inputs"]["main"] = ["2", 0]
    if with_bypass:
        g["10"]["inputs"]["bypass"] = ["1", 0]
    return g


def multi_graph(pick, present, prefix, switch=True, force=0):
    """多路汇聚用例：4 路 EmptyImage 各一种尺寸/颜色，只接 present 里列出的路。"""
    g = {}
    for k, (size, color) in ROUTES.items():
        g[str(k)] = {
            "class_type": "EmptyImage",
            "inputs": {"width": size, "height": size, "batch_size": 1, "color": color},
        }
    inputs = {"switch": switch, "pick": pick, "force": force}
    for k in present:
        inputs[f"input_{k}"] = [str(k), 0]
    g["10"] = {"class_type": "MultiAnySwitch", "inputs": inputs}
    g["20"] = {"class_type": "SaveImage", "inputs": {"images": ["10", 0], "filename_prefix": prefix}}
    return g


def channel_graph(present, prefixes=("mcs_ch1", "mcs_ch2"), force="auto", per=None):
    """多通道用例：present = {输入名: (尺寸, 颜色)}；每个通道一个 SaveImage 验证输出。

    per: 每个通道各自的强制选择，形如 {"ch1_force": "b", "ch2_force": "a"}。
    """
    g = {}
    inputs = {"switch": True, "pick": "first", "force": force}
    if per:
        inputs.update(per)
    for i, (name, (size, colour)) in enumerate(present.items(), start=1):
        node_id = str(i)
        g[node_id] = {
            "class_type": "EmptyImage",
            "inputs": {"width": size, "height": size, "batch_size": 1, "color": colour},
        }
        inputs[name] = [node_id, 0]
    g["10"] = {"class_type": "MultiChannelSwitch", "inputs": inputs}
    for k, prefix in enumerate(prefixes):
        g[str(20 + k)] = {
            "class_type": "SaveImage",
            "inputs": {"images": ["10", k], "filename_prefix": prefix},
        }
    return g


def fanout_graph(present, prefixes, per="2", off=()):
    """分发用例：present = {输入名: (尺寸, 颜色)}；每个输出一个 SaveImage。

    per: outputs per input ("2" / "3" / "4")
    off: output numbers to switch off, e.g. (2,) means output_2=off
    """
    g = {}
    inputs = {"outputs_per_input": per}
    for index in off:
        inputs[f"output_{index}"] = "off"
    for i, (name, (size, colour)) in enumerate(present.items(), start=1):
        node_id = str(i)
        g[node_id] = {
            "class_type": "EmptyImage",
            "inputs": {"width": size, "height": size, "batch_size": 1, "color": colour},
        }
        inputs[name] = [node_id, 0]
    g["10"] = {"class_type": "OutputFanoutSwitch", "inputs": inputs}
    for k, prefix in enumerate(prefixes):
        g[str(20 + k)] = {
            "class_type": "SaveImage",
            "inputs": {"images": ["10", k], "filename_prefix": prefix},
        }
    return g


def run_fail_case(name, graph):
    """预期会失败（强制走一路但那一路是空的）：只要执行没成功、且不是缺必填输入就算过。"""
    info, err = post_prompt(graph)
    if err is not None:
        msg = json.dumps(err, ensure_ascii=False)
        results.append((name, "Required input is missing" not in msg,
                        "提交即被拒: " + msg[:200]))
        return
    try:
        h = wait_history(info["prompt_id"])
    except TimeoutError:
        results.append((name, False, "等结果超时"))
        return
    status = h.get("status", {})
    msgs = json.dumps(status.get("messages", []), ensure_ascii=False)
    if status.get("status_str") == "success":
        results.append((name, False, "本该失败却成功了"))
    else:
        results.append((name, "Required input is missing" not in msgs,
                        "按预期失败（强制的那一路是空的），不是缺必填输入"))


def run_multi_case(name, graph, expects):
    """expects: [(保存节点 id, 尺寸, RGB), ...]，逐路核对产物。"""
    info, err = post_prompt(graph)
    if err is not None:
        results.append((name, False, "提交即被拒: " + json.dumps(err, ensure_ascii=False)[:300]))
        return
    try:
        h = wait_history(info["prompt_id"])
    except TimeoutError:
        results.append((name, False, "等结果超时"))
        return
    status = h.get("status", {})
    if status.get("status_str") != "success":
        results.append((name, False, "任务失败: " + json.dumps(status.get("messages", []), ensure_ascii=False)[:300]))
        return

    ok = True
    details = []
    for node_id, size, colour in expects:
        images = (h.get("outputs", {}).get(node_id) or {}).get("images") or []
        px = pixel_of(images[0]) if images else None
        if px is None:
            ok = False
            details.append(f"{node_id}: 没有产物")
            continue
        w, hgt, rgb = px
        good = (w, hgt) == (size, size) and rgb == colour
        ok = ok and good
        details.append(f"{node_id}={w}x{hgt}{rgb}" + ("" if good else f"(期望 {size}x{size}{rgb})"))
    results.append((name, ok, "; ".join(details)))


def run_case(name, graph, expect_ok, expect_colour=None, expect_size=(64, 64)):
    info, err = post_prompt(graph)
    if err is not None:
        node_errors = json.dumps(err, ensure_ascii=False)
        results.append((name, False, f"提交即被拒: {node_errors[:300]}"))
        return err
    pid = info["prompt_id"]
    try:
        h = wait_history(pid)
    except TimeoutError:
        results.append((name, False, "等结果超时"))
        return None

    status = h.get("status", {})
    ok = status.get("status_str") == "success" and not status.get("completed") is False
    msgs = json.dumps(status.get("messages", []), ensure_ascii=False)

    if not expect_ok:
        if ok:
            results.append((name, False, "本该失败却成功了"))
            return h
        bad = "Required input is missing" in msgs
        results.append((name, not bad,
                        "按预期失败，且不是 Required input is missing" if not bad
                        else "还是报 Required input is missing: " + msgs[:300]))
        return h

    if not ok:
        results.append((name, False, "任务失败: " + msgs[:400]))
        return h

    images = h["outputs"]["20"]["images"]
    px = pixel_of(images[0])
    if px is None:
        results.append((name, True, f"成功，产物 {images[0]['filename']}（无 PIL 未验色）"))
        return h
    w, hgt, rgb = px
    good = (w, hgt) == expect_size and rgb == expect_colour
    results.append((name, good,
                    f"{w}x{hgt} 中心像素 {rgb}，期望 {expect_size} {expect_colour}"))
    return h


print("== 真机用例 ==")

run_case("A. main 缺失(上游静音) + bypass=红  -> 应输出红",
         base_graph(True, "auto", with_main=False, with_bypass=True, prefix="mbs_A"),
         True, (255, 0, 0))

run_case("B. main=蓝 + bypass=红 -> 应输出蓝(主线优先)",
         base_graph(True, "auto", with_main=True, with_bypass=True, prefix="mbs_B"),
         True, (0, 0, 255))

run_case("C. switch=关 + main 缺失 -> 应失败(恢复原样)",
         base_graph(False, "auto", with_main=False, with_bypass=True, prefix="mbs_C"),
         False)

run_case("D. route=bypass + 两路都有 -> 应输出红",
         base_graph(True, "bypass", with_main=True, with_bypass=True, prefix="mbs_D"),
         True, (255, 0, 0))

run_case("E. 两路都缺 -> 应失败，但不是缺必填输入",
         base_graph(True, "auto", with_main=False, with_bypass=False, prefix="mbs_E"),
         False)

# ---- 多路汇聚：input_3 / input_4 在 INPUT_TYPES 里根本没有声明，靠动态输入进来
run_case("F. 多路：只接第 3、4 路（1、2 路等于被静音）-> 用第 3 路 64x64 蓝",
         multi_graph("first", [3, 4], prefix="mbs_F"),
         True, (0, 0, 255), (64, 64))

run_case("G. 多路：1~4 路全接 -> 用第 1 路 32x32 红",
         multi_graph("first", [1, 2, 3, 4], prefix="mbs_G"),
         True, (255, 0, 0), (32, 32))

run_case("H. 多路：pick=last + 全接 -> 用第 4 路 80x80 白",
         multi_graph("last", [1, 2, 3, 4], prefix="mbs_H"),
         True, (255, 255, 255), (80, 80))

run_case("I. 多路：只接第 2 路 -> 用第 2 路 48x48 绿",
         multi_graph("first", [2], prefix="mbs_I"),
         True, (0, 255, 0), (48, 48))

# ---- 多通道：每通道独立汇聚，ch2_* / ch3_* 都是动态输入
run_multi_case(
    "J. 通道1 的 a 缺失 -> 通道1 用 b(48x48 绿)；通道2 用 a(64x64 蓝)",
    channel_graph({"ch1_b": (48, GREEN), "ch2_a": (64, BLUE)}),
    [("20", 48, (0, 255, 0)), ("21", 64, (0, 0, 255))],
)

run_multi_case(
    "K. 通道1 a/b 都有 -> 用 a(32x32 红)；通道2 只有 b -> 用 b(80x80 白)",
    channel_graph({"ch1_a": (32, RED), "ch1_b": (48, GREEN), "ch2_b": (80, WHITE)}),
    [("20", 32, (255, 0, 0)), ("21", 80, (255, 255, 255))],
)

run_multi_case(
    "L. 开到第 3 通道，各通道取自己的 a（32红 / 64蓝 / 96灰）",
    channel_graph(
        {"ch1_a": (32, RED), "ch2_a": (64, BLUE), "ch3_a": (96, GRAY)},
        prefixes=("mcs_c1", "mcs_c2", "mcs_c3"),
    ),
    [("20", 32, (255, 0, 0)), ("21", 64, (0, 0, 255)), ("22", 96, (128, 128, 128))],
)

# ---- 强制选择（force）：自己指定走哪一路，不再自动挑
run_multi_case(
    "M. 多通道 force=b：两块都强制走 b（48绿 / 80白），而无视 a 有值",
    channel_graph(
        {"ch1_a": (32, RED), "ch1_b": (48, GREEN), "ch2_a": (64, BLUE), "ch2_b": (80, WHITE)},
        force="b",
    ),
    [("20", 48, (0, 255, 0)), ("21", 80, (255, 255, 255))],
)

run_multi_case(
    "N. 多通道 force=a：两块都走 a（32红 / 64蓝）",
    channel_graph(
        {"ch1_a": (32, RED), "ch1_b": (48, GREEN), "ch2_a": (64, BLUE), "ch2_b": (80, WHITE)},
        force="a",
    ),
    [("20", 32, (255, 0, 0)), ("21", 64, (0, 0, 255))],
)

run_fail_case(
    "O. 多通道 force=b 但通道1 的 b 没接 -> 交空，下游失败（不自动回退到 a）",
    channel_graph({"ch1_a": (32, RED), "ch2_a": (64, BLUE)}, prefixes=("mcs_f1",), force="b"),
)

run_multi_case(
    "P. 多路 force=2：无视第 1 路，强制用第 2 路（48绿）",
    multi_graph("first", [1, 2], prefix="mbs_P", force=2),
    [("20", 48, (0, 255, 0))],
)

run_fail_case(
    "Q. 多路 force=2 但只接了第 1 路 -> 交空，下游失败（不自动回退）",
    multi_graph("first", [1], prefix="mbs_Q", force=2),
)

run_multi_case(
    "R. 每通道各自强制：ch1_force=b(48绿)、ch2_force=a(64蓝)，互不干扰",
    channel_graph(
        {"ch1_a": (32, RED), "ch1_b": (48, GREEN), "ch2_a": (64, BLUE), "ch2_b": (80, WHITE)},
        per={"ch1_force": "b", "ch2_force": "a"},
    ),
    [("20", 48, (0, 255, 0)), ("21", 64, (0, 0, 255))],
)

run_multi_case(
    "S. 通道自己的 force 优先于总 force：总 force=b，ch1_force=a -> 32红；ch2 走 b -> 80白",
    channel_graph(
        {"ch1_a": (32, RED), "ch1_b": (48, GREEN), "ch2_a": (64, BLUE), "ch2_b": (80, WHITE)},
        force="b",
        per={"ch1_force": "a"},
    ),
    [("20", 32, (255, 0, 0)), ("21", 80, (255, 255, 255))],
)

run_fail_case(
    "T. ch1_force=b 但通道1 的 b 没接 -> 只有通道1 交空（ch2 照常，故只连一个 SaveImage）",
    channel_graph({"ch1_a": (32, RED)}, prefixes=("mcs_t1",), per={"ch1_force": "b"}),
)

# ---- 一对多分发：一个输入配几个输出，每个输出可单独关
run_multi_case(
    "U. 分发：1 路输入（32红）+ 配 2 个 -> out_1/out_2 都是它",
    fanout_graph({"in_1": (32, RED)}, ("mfo_u1", "mfo_u2")),
    [("20", 32, (255, 0, 0)), ("21", 32, (255, 0, 0))],
)

run_multi_case(
    "V. 分发：配 3 个 + 1 路输入 -> out_1..out_3 都是它",
    fanout_graph({"in_1": (32, RED)}, ("mfo_v1", "mfo_v2", "mfo_v3"), per="3"),
    [("20", 32, (255, 0, 0)), ("21", 32, (255, 0, 0)), ("22", 32, (255, 0, 0))],
)

run_multi_case(
    "W. 分发：2 路输入（32红 / 48绿）+ 配 2 个 -> 红、红、绿、绿",
    fanout_graph({"in_1": (32, RED), "in_2": (48, GREEN)},
                 ("mfo_w1", "mfo_w2", "mfo_w3", "mfo_w4")),
    [("20", 32, (255, 0, 0)), ("21", 32, (255, 0, 0)),
     ("22", 48, (0, 255, 0)), ("23", 48, (0, 255, 0))],
)

run_fail_case(
    "X. 分发：把「输出2」关掉 -> 接在 out_2 上的下游拿不到数据，失败",
    fanout_graph({"in_1": (32, RED)}, ("mfo_x1", "mfo_x2"), off=(2,)),
)

run_multi_case(
    "Y. 分发：配 3 个 + 2 路输入 -> 红红红、绿绿绿",
    fanout_graph({"in_1": (32, RED), "in_2": (48, GREEN)},
                 ("mfo_y1", "mfo_y2", "mfo_y3", "mfo_y4", "mfo_y5", "mfo_y6"), per="3"),
    [("20", 32, (255, 0, 0)), ("21", 32, (255, 0, 0)), ("22", 32, (255, 0, 0)),
     ("23", 48, (0, 255, 0)), ("24", 48, (0, 255, 0)), ("25", 48, (0, 255, 0))],
)

run_multi_case(
    "Z. 分发：关掉「输出2」但其它输出照常（out_1 仍 32红）",
    fanout_graph({"in_1": (32, RED)}, ("mfo_z1",), off=(2, 3, 4, 5, 6, 7, 8)),
    [("20", 32, (255, 0, 0))],
)

print()
fail = 0
for name, ok, detail in results:
    print(("  [PASS] " if ok else "  [FAIL] ") + name)
    print("         " + detail)
    fail += 0 if ok else 1
print(f"\n{len(results) - fail}/{len(results)} 通过")
sys.exit(1 if fail else 0)
