## 单场创作指令

你正在创作第 {{chapter_number}} 章的第 {{scene_index}}/{{scene_count}} 场：{{scene_title}}（{{scene_emphasis}}）。

### 整章任务

{{narrative_task}}

任务类型：{{task_type}}

### 本场契约

- 本场目标：{{scene_goal}}
- 入场与承接：{{scene_entry}}
- 具体阻力：{{scene_pressure}}
- 必须面对的选择：{{scene_choice}}
- 选择造成的后果：{{scene_consequence}}

### 本章唯一记忆点

{{memory_anchor}}

### 字数与承接

本场目标约 {{scene_target_words}} 字，硬上限 {{scene_max_words}} 字。只写这一场，不要写其他场景、标题、分析或计划。

上一场正文尾部（只用于自然承接，不要复述）：
{{previous_scene_tail}}

{{positioning_guidance}}

写作时让“欲望 → 阻力 → 选择 → 后果 → 新问题”在本场真实发生。场景必须以可观察的行动、感知和对话推进，不能用总结代替事件。写完调用 novel_submit_prose 工具提交本场正文（content 只放正文本身，不要重复输出到对话文本）。
