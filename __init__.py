"""ComfyUI 静音容错开关包 (Mute Bypass Switch)

解决：上游节点被静音/禁用 (Mute, Ctrl+M) 后，它的输出线在执行时消失，
下游节点的必填输入随之缺失，工作流报 "Required input is missing" 卡死。

包含五个节点：
  * 静音旁路开关 (MuteBypassSwitch)      —— 主线/旁路二选一，主线被静音时自动走旁路
  * 任意 A/B 开关 (AnyABSwitch)          —— 任意类型二选一
  * 多路汇聚开关 (MultiAnySwitch)        —— 想接几路接几路（输入口自动长），输出有值的那一路
  * 多通道汇聚开关 (MultiChannelSwitch)  —— 每个通道各自汇聚，通道数自动加（输入 + 输出一起长）
  * 输出分发开关 (OutputFanoutSwitch)    —— 一个输入配几个输出（2/3/4），每个输出可单独开关

数据只做引用转交，不复制、不转换、不修改。

License: MIT
"""

__version__ = "2.0.0"

from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "__version__"]

# 前端扩展目录（多路汇聚开关的"自动长出输入口"在这里）
WEB_DIRECTORY = "./web"
