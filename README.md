# DSH Plus · 会话编辑

在原会话中编辑、重试历史消息，并直接继续中断的会话。

这是 [DSH Plus](https://github.com/ArakawaHenri/dsh-plus) 系列的独立组件，包名为 `dsh-plus-session-edit`。

## 安装

在 DSH 插件管理器中安装本仓库：

```text
https://github.com/ArakawaHenri/dsh-plus-session-edit
```

也可以安装总包 `https://github.com/ArakawaHenri/dsh-plus`，一次启用全系列。
安装后按 DSH 的提示重启或刷新页面。

## 功能

- **编辑并重新生成**：修改指定用户消息，移除它之后的会话历史，再生成回答。
- **重试**：保留指定消息的内容，在同一会话中重新生成。
- **继续**：从手动停止、错误或 token 上限导致的中断处继续，不添加新的用户消息。

会话 ID、工作区、已有附件和当前模型选择保留。用户命名保留；自动标题根据有效历史更新。
编辑使用 DSH 原生行内编辑器、图标和提示。
可继续的会话在输入框为空时显示“继续”；输入文字或添加附件后恢复原生发送按钮。

历史重写使用本地 JSONL 存储，支持压缩日志，在原生写锁下验证并原子替换。
已执行的工具操作和文件改动不会回滚。

## 配置

无需配置。组件的 Loader ID 为 `dsh-plus-session-edit`。

## 兼容性

需要 Node.js `>=24`、DSH `>=0.2.1-rc.2`，开发测试基于 DSH `0.2.1-rc.2`。
新版本在所用宿主接口兼容时可加载。

编辑、重试需要 v4 会话格式、原生 JSONL writer/encoder 和完整 Agent 生命周期释放接口。
继续使用原生 wake/lifecycle hooks；前端通过原生投影接口重新加载历史。
缺失能力只影响需要该能力的操作，不阻止插件启动和其他操作。

## 开发

```sh
npm ci
npm run build
npm run check
npm test
```

编辑 `src/client.entry.js` 及其导入文件，使用 esbuild 生成根目录 `client.js`。
检查命令会核对生成文件、语言键和兼容范围；浏览器测试需要 Chromium 或 Chrome。
`npm run test:runtime`、`npm run test:browser` 可分别运行宿主和浏览器测试。

本地开发可通过插件管理器安装 `link:/absolute/path/to/dsh-plus/plugins/session-edit`。

## 许可

MIT。插件图标使用 DSH Plus 系列的 36 × 36 透明 SVG，参考 DSH 原生插件的蓝绿配色。
