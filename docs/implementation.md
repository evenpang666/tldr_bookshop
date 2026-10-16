# 薄书：DSH 插件实现

使用入口见 [README](../README.md)。启动时使用 npm `latest` 版本的 DSH，不设置宿主兼容版本限制。

## 插件与启动

`package.json` 导出 `plugin/index.mjs`，并声明 `dsh.bundle.patch` 指向 `cordis.patch.yml`。通过 `dsh plugin --profile web add <path>` 安装后，DSH 根据 bundle 加载插件。插件依赖宿主的 `agents`、`tools`、`systemPrompt`、`web`、`credentials`、`agentDefaultModel` 和 `profileContext` 服务。

双击脚本先通过 `scripts/bootstrap-node.sh` 或 `scripts/bootstrap-node.ps1` 检测 Node.js/npm。若缺少或 Node 低于 24.5，则根据系统与架构下载官方 Node.js 24 LTS 的便携压缩包，与官方 `SHASUMS256.txt` 比对 SHA-256，解压后验证 Node/npm 可运行，再启用项目 `.runtime/node/current/`。复用可用系统环境，不需要管理员权限，不改系统 PATH。

随后 `scripts/environment.mjs` 配置本次子进程的 PATH、`NODE_USE_ENV_PROXY`、本机地址的 `NO_PROXY` / `no_proxy`，保留已有代理值与绕过地址；创建并验证缓存和运行目录可写。校验生产依赖的版本及入口，发现缺失或损坏时执行 `npm ci --omit=dev`；npm 安装包没有 lockfile 时改用 `npm install --omit=dev --no-package-lock`。`npm start`、`npm run dev` 和 `npm run dsh` 也使用同一入口；Node/npm 不可用时转交平台 bootstrap 后重新启动。

`scripts/launch.mjs` 先读取当前 DSH_HOME 的薄书服务记录 `<home>/thinbook/host.json`，检查记录进程和健康接口，再检测当前 DSH Web 进程。Linux 仅检查同用户的 DSH CLI 进程及其 `DSH_HOME`，区分其他 home 下的实例；Windows 使用系统进程查询，macOS 使用 `ps`。不会把 SDK、配置 dump 或包管理命令当作 Web 服务。

通过 `<home>/.thinbook-start.lock` 串行化同一 home 的启动。为当前 `web` profile 的 `cordis.patch.yml` 追加带标记的薄书配置块，其他 YAML 保持原样，后续更新只替换此块；原文件为 JSON 列表时转成等价的 YAML 条目。文件以临时文件加重命名更新，写入前检查是否被其他进程修改。DSH 默认 HMR 观察该文件，因此已有 Web 服务可直接热加载薄书；其他插件不会重新创建，不会导致 `whereto` 的固定端口重复监听。

只有没有运行中的 DSH Web 时，才检查并更新运行时，通过官方 config dump 初始化 profile（不启动 Web），写入薄书配置，并执行：

```text
dsh --profile web --no-open --host 127.0.0.1 --port 0
```

启动前再次检查进程，避免配置过程中外部已启动 DSH。已有服务未能热加载时返回 HMR 检查提示，不回退为第二个 DSH。复用服务时立即打开薄书并结束启动器，不发送停止信号；自己创建的 DSH 才由该启动器管理退出。`npm run dsh -- web` 与首次配置入口也复用已运行的服务。

薄书默认监听 `3210`，端口冲突时自动避让。插件启动后写入当前进程、薄书端口、DSH Web 端口及 profile 的私有服务记录，不包含 API Key、浏览器 token 或 cookie；卸载时仅清理自己写入的记录。健康检查通过后，将实际地址写入项目 `.local/launcher.json`，供重复启动复用。凭据、系统代理与防火墙不修改。
DSH 是可选 peer 宿主和开发依赖，生产依赖只有 Undici。`DSH_BIN` 可覆盖 CLI 查找，Windows npm shim 解析到 JS 入口后直接运行，避免 shell 路径转义。
没有正在运行的 DSH Web、需要创建服务时，通过 `npm view @deepseek-ai/dsh@latest version --json --prefer-online` 查询最新发布版本，比较已有 DSH 的实际版本。最新版直接复用；缺少、不可运行或版本不同则自动安装该次查询到的最新版到 `<DSH_HOME>/runtimes/thinbook/current/`。不进行兼容性筛选，插件的 DSH peer 范围为 `*`。开发依赖中的精确版本仅用于可重复的测试快照，不限制用户启动的运行时。

安装使用临时目录、版本复核和重命名启用，失败不替换旧安装；同版本并发安装可以复用已完成的结果。整个流程保持 `DSH_HOME` 和凭据环境不变，不执行全局安装，不需要管理员权限。无法查询更新时，如果已有可用安装，会明确提示后继续启动；无可用安装则报告网络或 npm 错误。

`npm run dsh -- <参数>` 提供同样自动检测和升级的 CLI 入口，便于管理宿主。无全局 Node/npm 时，Windows 使用 `configure.bat`、Linux 使用 `sh start.sh --dsh web` 配置 API Key，或进行插件管理。普通双击仍使用 `--no-open`，不会打开 DSH Web。

## 模型与凭据

`plugin/index.mjs` 每次通过 `agentDefaultModel.currentSelection()` 读取模型，通过 `credentials.describe('DEEPSEEK_API_KEY')` 检查配置状态。薄书不解析 DSH 的凭据文件、不读取原始 Key、不将密钥注入子进程，也不保存 `.local/config.json`。DSH 按自己的凭据规则解析与更新 Key。当前入口仅接受 `deepseek-official` 默认路由。

网页只得到模型、provider 和配置是否就绪。旧版设置与测试 Key 接口拒绝写入；设置弹窗只提供配置状态和刷新。旧浏览器中的薄书 Key 会被清除；旧项目配置文件不自动迁移或删除。

`harness/reader.mjs` 使用宿主 `ctx.agents.create()` 为每篇阅读创建独立会话，指定 provider、model、reasoningEffort 与输出上限。在发布前的 setup 中：

- 排除继承的工具，仅在该会话注册官方 `web_search` 和 `web_fetch`，使用 native 工具模式。
- 将 `.dsh/skills/thin-book/SKILL.md` 嵌入完整系统提示，抑制无关工作目录上下文。
- 观察该会话工具调用，提供进度，限制调用次数。

官方工具和 `createUserMessage` 从 `profileContext.installAnchor` 对应的 DSH 安装解析，避免项目依赖提供另一套服务。向 `followup()` 提交前，通过该工厂生成带有稳定 ID、`role: user` 和来源的不可变消息；直接传入仅有 content/source 的对象会导致真实请求适配器序列化失败。用户断开连接、取消或超过 12 分钟时，仅取消本次会话；最终始终 dispose 自己持有的 AgentHandle，不结束共享 DSH。

每个阅读会话通过 `await agentCtx.plugin(webTools, options)` 挂载官方联网工具，完成 Config 校验、`web` 等服务注入和工具作用域注册后再发布会话。直接调用模块的 `apply()` 会绕过依赖注入，导致工具已列出但执行时报 `cannot get property "web" without inject`。

提炼结束时检查结构化的 `turn/end.reason` 和 `LlmFailure.code/status`，分别提示认证、额度、限流、传输、模型配置和输出超限等原因。`lib/reading-error.mjs` 只返回固定提示，不将提供方原始错误正文或凭据暴露到网页；失败或截断的结果不会写入缓存。

会话日志和模型请求由 DSH 自身管理，遵循 DSH 的持久化和隐私设置。用户导入的原文会进入模型请求及 DSH 会话日志，不能再按旧 SDK 方案声称临时日志会立即删除。

原生适配器的离线回归保留真实 DSH 提供方、请求序列化和 SSE 解码，只将 HTTP 边界替换为模拟响应。无原文场景实际执行官方 `web_search` 和 `web_fetch`，经 DSH `web` 服务调用模拟搜索与抓取提供方，核验工具结果、来源元数据及最终正文；同时覆盖联网服务错误、依赖注入失败、资料不足、认证失败、额度不足、传输异常与输出超限，确认失败结果不缓存、提供方错误原文不返回网页。测试环境显式安装 DSH 的可选开发 peer `dsh-agent-preset-registry`，确保 npm 的开发依赖布局中请求扩展可正确解析。

## 缓存与费用

`lib/storage.mjs` 只负责磁盘缓存，以临时文件加重命名原子写入，目录 0700、文件 0600（Windows 遵循目录 ACL）。缓存身份包含书名、作者、provider、模型、reasoningEffort、阅读时长、原文哈希、完整原文标记、skill 哈希及 schema 版本。

双击默认复用项目 `.local/readings/`；常驻安装默认使用 `<DSH_HOME>/thinbook/.local/readings/`。可通过插件的 `dataRoot` 配置更换缓存根目录。旧版缓存仍可读取，新缓存身份不会与旧规则混用。书架、字号和进度保存在各设备浏览器。

缓存命中不调用模型；`force: true` 可重新生成，可能再次计费。原生成费用留在缓存，读取缓存另标本次 API 费用为零。费用按会话中的 `assistant/message.usage` 估算，搜索额外用量仍是参考假设。价格快照在 `lib/cost.mjs`，不是实时账单。

## 网络与内容边界

书目检索优先 Open Library，失败或无结果时尝试 Google Books。`lib/network.mjs` 使用 Undici 环境代理，代理失败时尝试直连，不关闭 TLS 校验。远程书库全不可达时明确降级为本地匹配。

正文取材使用 DSH 自身的网页搜索与抓取能力。来源 URL 与成功工具记录交叉核验；没有原文时至少需要两条实际检索来源。此检查不等于逐项事实验证。小说保留主线与结局，非虚构保留命题、论证及边界；资料不足时提示缺口。

薄书默认监听 `0.0.0.0:3210`，只接受回环与私有网段客户端、实际网卡对应 Host，验证来源和每次启动的写入 token。可信局域网设备可以共用主机模型额度与缓存。DSH 自身仍绑定回环地址；用户自行管理防火墙，不要进行公网端口映射。

`lib/network.mjs` 统一生成页面与终端的局域网链接，仅展示一个优选地址：以太网 `192.168.*` 优先，其次为其他 `192.168.*`、其他以太网私有地址及其他私有地址。排除虚拟网卡和 VPN；没有合适地址时不展示链接。完整网卡地址仍用于 Host 校验，优选展示不会改变服务监听与访问权限。

## 验证

Node.js 24.5+ 下执行 `npm ci`、`npm test`。`scripts/check-harness.mjs` 使用临时 DSH_HOME、伪凭据及测试专用模型流，实际启动官方 DSH Web、加载插件、生成两篇阅读并验证缓存、配置只读和 Key 不返回。其他测试覆盖已有 DSH 热加载接入、独占端口插件不重复激活、HMR 关闭时拒绝创建第二个服务、启动锁、profile 配置保留、缺少 Node/npm、旧 Node、下载校验与清理、依赖自动修复、端口避让及重复启动、DSH 自动安装与失败恢复、输入与来源检查、书库系列、费用、缓存身份与局域网权限。付费模型与真实联网搜索质量需要有效 Key 单独验证。
