# dsh-session-edit

为 DeepSeek Harness (`0.2.1-rc.2`) 提供历史消息编辑分叉、重试以及中断会话继续功能。

## 功能

- **编辑并分叉**：保留选中用户消息之前的历史，在新会话分支中发送修改后的内容。
- **重试此消息**：保留选中用户消息之前的历史，在新会话分支中重新发送该消息。
- **继续任务**：对于手动停止、报错或达到输出上限的会话，支持直接以当前历史发起新一轮请求（不额外插入用户消息），或显式发送继续指令。继续指令会根据界面语言（中/英）和会话停止原因（手动中断／输出截断／请求失败）自动选择合适的措辞。

可在对话气泡下方直接点击 **编辑** / **重试**，或通过侧栏会话菜单中的 **编辑历史／重试…** 浏览分页历史。

## 安装

在 DSH 插件管理器中添加本地链接并启用后刷新页面（将下面的路径替换为本机克隆位置）：

```text
link:<本仓库的本地克隆路径>
```

## 配置（可选）

可在插件配置中调整单条编辑消息的最大长度，或针对特定模型禁用无消息直接继续：

```yaml
- id: session-edit
  name: 'dsh-session-edit'
  config:
    maxTextChars: 131072
    continuationRules:
      - provider: your-provider-id
        model: your-model-id
        allow: false
```

## 开发与测试

```sh
npm run build
npm run check
npm test
```

## 许可

MIT License
