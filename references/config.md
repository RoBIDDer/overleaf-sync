# 配置文件

都放在本地 LaTeX 文件夹的 `.overleaf/` 中。

`settings.json`（`服务器主机名` 必须与 Overleaf Workshop 里的服务器名一致，如 `www.overleaf.com`）：

```json
{
  "uri": "overleaf-workshop://服务器主机名/名称?user=&project=项目ID",
  "serverName": "服务器主机名",
  "enableCompileNPreview": false,
  "projectName": "名称"
}
```

`bisync.json`：

```json
{ "autoPull": true, "pollSeconds": 600 }
```

- `autoPull`：`false` 关闭自动拉取。
- `pollSeconds`：兜底检查间隔，最少 60。
- `textDirs`：可选，限定同步文本的顶层文件夹，`""` 表示根目录。

`.gitignore`：内容为一行 `*`，避免把同步状态和备份提交到 git。

自动生成：`bisync-state.json`（状态）、`bisync-base/`（合并基准）、`bisync-backup/`（覆盖前备份）。不要手工编辑前两项；删除它们等于重新首次同步。
