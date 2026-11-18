# 协作版本库转储的复制谱系与修订资料接收

这是面向资料接收人员的 Node.js 服务。当前提供人工收件、原始字节保管、业务身份版本记录和收件查询；本地来源独立提供合作方交互环境。自动来源接入以只读转储领取提供：`POST /api/collect` 从来源目录领取 SVN 转储(格式 2)字节，按确认边界把完整修订交接进归档，不启动版本库服务器，也不执行转储中的任何内容。

## 环境

支持 Node.js 22.22.1 及以上的 22.x 补丁版本；项目 Dockerfile 仍固定原有镜像摘要以保证可复现，正式 Linux 基线另外在 Node.js 22.23.4 验证。运行期没有第三方包及公网数据依赖。`npm ci --ignore-scripts --no-audit --no-fund` 安装锁定环境，`npm run build` 检查所有模块语法，`npm test` 验证归档、HTTP 入口及来源行为。来源材料均为本地合成的业务样本，没有真实账号、个人材料或访问外部站点的要求。

`npm start` 同时启动收件服务 3200 和来源 4200；可分别通过 `PORT`、`SOURCE_PORT` 修改端口。`ARCHIVE_DIR` 指定收件目录，默认 `.local/archive`；`SOURCE_URL` 指定 `POST /api/collect` 的默认来源，默认 `http://127.0.0.1:4200`。`npm run demo` 使用临时目录和系统分配端口展示截断领取、边界续领、导出更换后重新领取与人工收件，结束即清理，通常只需数秒。

## 容器

`docker build -t revision-dump:local .` 构建环境，`docker run --rm -p 3200:3200 -p 4200:4200 revision-dump:local` 启动。环境准备后，`docker run --rm --network none revision-dump:local sh -c 'npm run build && npm test && npm run demo'` 可离线检查现有功能。正式展示应从干净归档启动真实新增功能并展示当前输出，完整操作限时 90 秒；准备镜像不计入运行时间。

## 接口与目录

`POST /api/manual` 接收 `fixtures/manual.json` 同形的业务对象，`GET /api/records` 查询全部收件版本(人工与转储交接)，`GET /health` 检查进程。人工记录身份字段为 repositoryUuid, revision, nodePath。同一身份与相同原文重复提交复用版本，内容变化保留旧版本；不同来源不能混淆。归档目录有按摘要保存的 blobs 和按业务身份保存的 receipts。

`POST /api/collect` 执行一轮只读领取，请求体可带 `source`(默认 `SOURCE_URL`)与 `reset`。响应说明已有材料的边界：received(已取得字节)、committedOffset(已交接字节，只覆盖完整修订)、committedRevisions、pendingRevision、sealed。续领时向来源发送 Range(从已交接边界起)与 If-Match(锁定导出实例)；来源以 412 或目录 etag 变化表明导出实例已更换时，返回 export-changed 且不拼接两次导出的尾部，确认后以 `reset: true` 从当前导出重新领取。校验或解析失败返回 error 并随游标锁定，已交接的修订保持有效。`GET /api/collect` 查询各来源游标的上述边界。

`GET /api/dump/revisions` 列出已交接修订，`GET /api/dump/revisions/:n` 给出该修订的属性与节点变更(动作、谱系 lineage、copiedFrom、属性操作与结果、正文摘要)，`GET /api/dump/state?revision=n` 重建该修订的文件、属性与目录关系，`GET /api/blobs/:sha256` 取回正文或修订原始字节。修订只有完整确认后才交接：下一条修订记录或封口导出的完整字节终点构成边界，截断的尾部不会提前变成可用版本。复制按 copyfrom 修订定格来源子树，源分支之后的修改不影响副本；同一路径删掉重建分配新谱系，不会接回原来的对象谱系。差分正文核对基底与结果 md5，属性删除与空值区别保留。

`src/` 为收件、转储解析(dump/svndiff)、历史重建(history)、领取(collect)与传输，`provider/` 为独立来源服务，`fixtures/` 保留来源字节与人工记录，`test/` 验证现有行为。协议范围与局部身份约定见 `docs/source-contract.md`，该文档不规定新增接入的架构。
