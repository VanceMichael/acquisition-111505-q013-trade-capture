# 协作版本库转储的复制谱系与修订资料接收

这是面向资料接收人员的 Node.js 服务。当前提供人工收件、原始字节保管、业务身份版本记录、收件查询，以及合作方版本库的**只读转储接入**：不启动版本库服务器，直接从来源领取转储流，按修订重建文件、属性与目录关系供查询。本地来源独立提供合作方交互环境。

## 环境

支持 Node.js 22.22.1 及以上的 22.x 补丁版本；项目 Dockerfile 仍固定原有镜像摘要以保证可复现，正式 Linux 基线另外在 Node.js 22.23.4 验证。运行期没有第三方包及公网数据依赖。`npm ci --ignore-scripts --no-audit --no-fund` 安装锁定环境，`npm run build` 检查所有模块语法，`npm test` 验证归档、转储接入、HTTP 入口及来源行为。来源材料均为本地合成的业务样本，没有真实账号、个人材料或访问外部站点的要求。

`npm start` 同时启动收件服务 3200 和来源 4200；可分别通过 `PORT`、`SOURCE_PORT` 修改端口。`ARCHIVE_DIR` 指定收件目录，默认 `.local/archive`；`SOURCE_URL` 指定转储来源地址，默认指向同机 `SOURCE_PORT` 的来源服务。`npm run demo` 使用临时目录和系统分配端口演示截断分段交接、补领封口、复制谱系查询与人工收件，结束即清理，通常只需数秒。

## 容器

`docker build -t revision-dump:local .` 构建环境，`docker run --rm -p 3200:3200 -p 4200:4200 revision-dump:local` 启动。环境准备后，`docker run --rm --network none revision-dump:local sh -c 'npm run build && npm test && npm run demo'` 可离线检查现有功能。正式展示应从干净归档启动真实新增功能并展示当前输出，完整操作限时 90 秒；准备镜像不计入运行时间。

## 接口与目录

### 只读转储接入

`POST /api/collect` 从 `SOURCE_URL` 领取转储并交接完整修订，返回本次领取与已有材料边界；`GET /api/dump/status` 查询 repositoryUuid、导出实例、已消费字节、已交接修订、待决修订与封口状态；`GET /api/dump/revisions` 列出已交接修订及其修订属性与节点变更（含复制来源对象 id）；`GET /api/dump/revisions/{rev}/node?path=...` 按修订查询节点类型、谱系 id、属性，文件附正文与 md5，目录附子项。待决修订与未交接修订一律 404。

接入语义：

- 修订只有在下一修订头出现或封口导出干净结束时才交接；来源分段停在修订中间时，先前完整修订可以交接，该修订保持待决，不提前变成可用版本。
- 续领用 `If-Match` 钉住导出实例并按已交接边界发闭区间 `Range`；导出实例更换（etag 变化）即整体重领，不把两次不同导出的尾部拼在一起；repositoryUuid 不同的来源不能混入。
- 复制操作锚定过去某个修订的路径，之后源分支再改不影响副本；同一路径删除重建会发新谱系 id，不会接回原对象谱系；变更记录留存复制来源对象 id 备查。
- 差分正文（svndiff0）核对基底 md5 与结果 md5/sha1 后才入库；不支持的差分版本明确隔离；不执行仓库钩子、脚本或转储正文。
- 属性删除（D）与空值（V 0）区别保留；修订属性与节点属性独立；`Prop-delta` 表示改属性，否则完整替换。
- 坏校验和、截断记录、越界路径等坏材料会被拒绝且不入档；已消费字节原样落档（`dump/prefix.dump`），重开服务由前缀重放恢复。

### 人工收件

`POST /api/manual` 接收 `fixtures/manual.json` 同形的业务对象，`GET /api/records` 查询全部人工收件版本，`GET /health` 检查进程。人工记录身份字段为 repositoryUuid, revision, nodePath。同一身份与相同原文重复提交复用版本，内容变化保留旧版本；不同来源不能混淆。归档目录有按摘要保存的 blobs、按业务身份保存的 receipts，以及转储接入的 dump 前缀与状态。

`src/` 为收件、转储解析、历史重建与传输，`provider/` 为独立来源服务，`fixtures/` 保留来源字节与人工记录，`test/` 验证现有行为。协议范围与局部身份约定见 `docs/source-contract.md`，该文档不规定新增接入的架构。
