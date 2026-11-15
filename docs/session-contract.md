# 会话与业务范围

/poll 回传的 messages 是原始 FIX 4.4 风格字符串。BodyLength 为 tag 9 后到 tag 10 前的字节数；CheckSum 是此前全部字节和模256，格式三位。序号在 sessionDay、SenderCompID、TargetCompID 内有效。MsgType AE 是成交回报，4 是 SequenceReset；GapFill=Y 时 NewSeqNo 表示管理跳号上界，不生成成交。/session/resend 按 from/to 请求补发，PossDup=Y 且 OrigSendingTime 指向原传输。TradeReportTransType 0/1/2 分别新报、撤销、更正；撤销与更正的 TradeReportRefID 指向业务前件。
