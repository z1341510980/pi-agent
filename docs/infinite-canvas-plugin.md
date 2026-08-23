# PI Agent Infinite Canvas 插件

## 定位

`infinite-canvas-plugin` 是 PI Agent 的独立 builtin 插件，用于把 Prompt、文件引用、文本草稿、Agent 结果和工作流步骤放到一张可缩放的画布上。

它不依赖 `novel-plugin`，不读取小说表，也不复制参考项目的图片/视频供应商接入。

## 参考来源

交互和节点工作流参考 `basketikun/infinite-canvas`。该项目使用 MIT License；本插件只复用其公开的产品思路（无限画布、节点、连线、缩放、导入导出、Agent 操作），没有复制其源码、品牌资源或供应商配置。

## 已实现能力

- 画布项目创建、读取、重命名、删除。
- 文本、Prompt、文件、Agent 结果、图片占位和分组节点。
- 节点拖拽、标题/内容编辑、删除和坐标持久化。
- 节点连线、连线删除和项目视口缩放。
- JSON 导入和导出。
- Agent session tools：`canvas_list_projects`、`canvas_get_project`、`canvas_create_node`。
- 插件管理页可查看、停用和重新启用插件；停用后 UI contribution 消失，路由/服务按宿主规则标记重启边界。

## 插件接口

接口统一位于 `/api/plugins/infinite-canvas`：

- `GET/POST /projects`
- `GET/PATCH/DELETE /projects/:projectId`
- `POST /projects/:projectId/nodes`
- `PATCH/DELETE /nodes/:nodeId`
- `POST /projects/:projectId/connections`
- `DELETE /connections/:connectionId`

数据存储在 SQLite 的 `infinite_canvas_projects`、`infinite_canvas_nodes` 和 `infinite_canvas_connections` 表中。数据属于 `persistent`，停用插件不会删除用户画布。

## 桌面接入

服务端贡献：

- `infinite-canvas.workspace` → `workspace.main`，`entryKey=infinite-canvas`。
- `infinite-canvas.navigation` → `app.navigation`。

桌面端通过受信 renderer 白名单解析，不执行插件下发的源码。入口视图为 `plugin:infinite-canvas`。

## 当前边界

- 图片、音频、视频节点当前是工作流占位/元数据节点，不直接调用外部媒体 Provider。
- 多人协同、实时广播、画布级权限和附件二进制存储尚未实现。
- Agent 工具当前以项目 ID 为边界，不自动推断当前用户正在查看的画布。
