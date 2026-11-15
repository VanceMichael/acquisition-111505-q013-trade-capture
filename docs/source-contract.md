# 版本历史交付约定

## 来源领取

`GET /exports` 给出 repositoryUuid 与获准导出实例的 id、generation、size、sha256、etag、sealed、相对 href。正文支持单一闭区间 Range 与 If-Match；导出变化会令旧 ETag 返回412，不能用字节偏移跨导出续接。sealed=false 表示来源尚未封口，不代表所见最后修订完整。

## 转储子集

支持 SVN-fs-dump-format-version: 2、UUID 和按递增修订编号的 Revision-number 记录。头部为 ASCII 键值行，以空行结束；Content-length 是后续内容字节数，空行和属性值都不能用逐行切分猜正文。属性块使用 K、V、D 的长度定界条目与 PROPS-END；空字符串是存在但值为空，D 是删除。修订属性与节点属性独立，Prop-delta=true 表示改属性，否则是完整属性替换。

节点支持 dir/file，action 为 add、change、delete、replace，路径从仓库根计，不以文件名识别对象。copyfrom-rev/path 指定历史修订中的源对象，目录复制包括当时子树，但后续修改不回写到源修订。Text-delta=true 的正文为 svndiff0：SVN加零字节标记后为一个或多个窗口，source offset、source length、target length、instruction length、new-data length 使用大端7位续位整数。指令高2位为 source/target/new，低6位为长度，零长度则后跟续位整数；source/target 后有偏移。每个窗口的 target 输出追加到文件，target copy 可引用当前窗口已生成的部分。base-md5 核验适用基底，content-md5 核验重建结果；不支持的差分版本明确隔离，不执行仓库钩子、脚本或转储正文。

单个修订没有专门结束标记；下一修订头或封口导出的完整字节终点构成可确认边界。截断的头、内容和差分窗口不能伪装成空节点。实际修订号可有间隔，不能自行补造修订。来源对合法路径采用 UTF-8，拒绝绝对及上级越界路径。

## 产品现状

`POST /__control` 仅改变本地 mode=complete|truncated|bad-checksum 与 generation。人工入口只接收已核对的 repositoryUuid、revision、nodePath；`Archive.accept` 为同来源同身份保留原文版本。自动转储读取、历史状态重建与修订发布尚未提供。来源、人工收件和归档是现有独立模块，不能把来源生成逻辑当作解析器。
