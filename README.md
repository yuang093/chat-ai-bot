# AI 回覆助手 (M6C)

Powered by **MiniMax-M3** + Vercel Serverless. 

> 5 種回覆風格（正經 / 高 EQ / 智慧 / 幽默 / 挑逗），加上第 6 格自訂風格。

## 部署到 Vercel

### 第一次部署
```bash
cd /Users/taeyeon093.bot/Developer/reply-app
vercel login
vercel
```

### 設定環境變數（API Key）
```bash
vercel env add MINIMAX_API_KEY production
# 貼上你的 MiniMax API key
# 設定 REPLY_TOKEN（選用, 但強烈建議）
vercel env add REPLY_TOKEN production
# 隨機生成一組 token, 給前端呼叫時驗證
```

### 正式部署
```bash
vercel --prod
```

## 檔案結構
```
reply-app/
├── index.html        ← 前端 (無 API Key)
├── api/
│   └── reply.js      ← Vercel Serverless Function (含 Key)
├── vercel.json       ← 路由設定
├── package.json
└── .gitignore
```

## 安全設計
- ✅ API Key 在 Vercel 環境變數, 不進 Git
- ✅ 後端限流: 每分鐘每 IP 5 次
- ✅ 選用 Token 驗證 (REPLY_TOKEN 環境變數)
- ✅ CORS 控制 (ALLOWED_ORIGIN 環境變數)
- ✅ 訊息長度限制 (her 2000 / ctx 500 / extras 500)
