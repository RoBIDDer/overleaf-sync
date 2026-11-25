# overleaf-sync

本地 LaTeX 文件夹与 Overleaf 项目的双向增量同步，做成可直接安装的 Agent Skill。

A two-way, incremental sync between a local LaTeX folder and an Overleaf project, packaged as an agent skill. [English below](#english).

## 中文

### 它做什么

包含两部分：一个 VS Code 扩展负责同步，一份 `SKILL.md` 让 AI agent 引导安装、首次配置和排错。扩展借用 [Overleaf Workshop](https://github.com/overleaf-workshop/overleaf-workshop) 的登录状态，支持自建 Overleaf，设计上也支持 overleaf.com（尚未测试）。

- **自动拉取**：VS Code 打开文件夹时，网页上的改动会进入本地。自动过程不上传、不删除。
- **手动上传**：运行命令后才会上传本地改动。
- **按行合并**：两边改了不同位置会自动合并；同一行或相邻行冲突时才询问你。
- **增量**：图片没有变化就不重新下载。
- **自动纳入图片**：被 tex 正文引用的 pdf、png、jpg、jpeg、eps 会自动上传。
- **安全措施**：删除前询问，覆盖本地文件前备份，上传后从服务器回读核对；远端对 `latexmkrc` 的改动不会自动应用。

### 安装

需要 VS Code 1.80+、git，以及 `code` 命令。

**用 Claude Code**（PowerShell）：

```powershell
git clone https://github.com/RoBIDDer/overleaf-sync "$HOME\.claude\skills\overleaf-sync"
```

macOS / Linux：

```bash
git clone https://github.com/RoBIDDer/overleaf-sync ~/.claude/skills/overleaf-sync
```

然后对 agent 说：“用 overleaf-sync 配置我的论文同步”。其他 agent 请放进它们各自的 skills 目录。

**不用 agent**：

```bash
code --install-extension iamhyc.overleaf-workshop
code --install-extension overleaf-paper-sync-1.0.0.vsix
node scripts/setup.mjs --folder "<LaTeX 文件夹>" --url "<Overleaf 项目网址>" --name "<名称>"
```

在 VS Code 的 Overleaf Workshop 面板里自己登录。没有 node 时，按 [references/config.md](references/config.md) 手工创建配置。

### 首次同步

先备份或提交本地文件夹。

1. 用 VS Code 单独打开该文件夹，重新加载窗口。
2. 运行 **Overleaf: 检查差异（只读）**，查看有哪些不同。
3. 运行 **Overleaf: 同步**。首次没有共同基准，内容不同的文件需要整份选择以哪边为准。

之后改完本地，运行 **Overleaf: 同步** 即可。

### 限制

- 依赖 Overleaf Workshop 的内部接口，只在 0.15.10 上用过，它升级后可能需要适配。
- 按行合并只保证文本不冲突，不保证意思连贯，合并后建议编译检查。
- 图片等二进制文件两边都改时，只能选一份。
- 不要对同一文件夹启用 Overleaf Workshop 的 Local Replica：它启动时会用远端内容覆盖本地同名文件。
- 每次同步时会读取全部文本文件，项目越大越慢。

### 验证情况

- 用模拟服务器测试了合并、冲突、删除、图片替换等情况：`node tests/simulate.js`。
- 在 Windows 和一个自建 Overleaf 上完成过检查、首次同步，以及网页改动的自动拉取。按行合并和冲突处理目前只在模拟环境中验证过。
- 未在 overleaf.com、macOS、Linux 上测试。首次使用请先跑只读检查。

## English

### What it does

It has two parts: a VS Code extension that does the syncing, and a `SKILL.md` that lets an AI agent guide installation, first-time setup and troubleshooting. The extension uses the login session of [Overleaf Workshop](https://github.com/overleaf-workshop/overleaf-workshop). It works with self-hosted Overleaf and is meant to work with overleaf.com, which is untested.

- **Automatic pull**: edits made on the web reach the local folder while it is open in VS Code. The automatic pass never uploads or deletes.
- **Manual push**: local edits upload only when you run the command.
- **Line-level merge**: edits in different places merge by themselves. You are asked only when the same or adjacent lines conflict.
- **Incremental**: unchanged images are not downloaded again.
- **Images included automatically**: pdf, png, jpg, jpeg and eps files cited in the tex sources upload by themselves.
- **Safeguards**: it asks before deleting, backs up local files before overwriting them, and reads uploads back from the server. Remote changes to `latexmkrc` are never applied automatically.

### Install

You need VS Code 1.80+, git and the `code` command. Clone this repository into your agent's skills folder, for example `~/.claude/skills/overleaf-sync` for Claude Code (commands above), then ask the agent to set up sync for your paper.

Without an agent, run the three commands in the Chinese section above, and sign in yourself in the Overleaf Workshop panel. Without node, create the configuration by hand from [references/config.md](references/config.md) (in Chinese).

### First sync

Back up or commit your local folder first.

1. Open the folder on its own in VS Code and reload the window.
2. Run **Overleaf: 检查差异（只读）** (read-only check) to see what differs.
3. Run **Overleaf: 同步** (sync). There is no common base yet, so each differing file is taken whole from one side.

The extension's interface is in Chinese.

### Limitations

- It relies on internals of Overleaf Workshop and has only been used with 0.15.10. Later versions may need changes.
- A clean merge means no text conflict, not that the prose still reads well. Compile and check.
- If both sides change the same binary file, you pick one.
- Do not enable Overleaf Workshop's Local Replica on the same folder. On startup it overwrites local files with the remote copies.
- Every sync reads all text files, so large projects take longer.

### What has been tested

- Merging, conflicts, deletion and image replacement against a simulated server: `node tests/simulate.js`.
- Check, first sync and automatic pull of web edits on Windows with one self-hosted Overleaf. Line-level merging and conflict handling have so far been verified only in simulation.
- Not tested on overleaf.com, macOS or Linux. Run the read-only check first.

## License

[MIT](LICENSE)

This is an independent project. It is not affiliated with or endorsed by Overleaf or Overleaf Workshop.
