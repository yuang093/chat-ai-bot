// api/reply.js - Vercel Serverless Function
// API Key 由 Vercel 環境變數 MINIMAX_API_KEY 提供
// 呼叫者只能看到「訊息 → 收到 3 個版本」，看不到 Key
//
// 環境變數（在 Vercel 後台設定）:
//   MINIMAX_API_KEY  ← 你的 MiniMax API key
//   REPLY_TOKEN      ← 簡單的呼叫 token（防止公開亂用）

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const REPLY_TOKEN = process.env.REPLY_TOKEN || "";

// 簡易 in-memory 限流（每分鐘每 IP 5 次）
// Vercel 跨實例會失去狀態, 但對防一般濫用已足夠
const rateLimit = new Map();
const RATE_LIMIT_PER_MIN = 5;

function checkRate(ip) {
  const now = Date.now();
  const rec = rateLimit.get(ip) || { count: 0, window: now };
  if (now - rec.window > 60000) {
    rec.count = 0; rec.window = now;
  }
  rec.count++;
  rateLimit.set(ip, rec);
  return rec.count <= RATE_LIMIT_PER_MIN;
}

const STYLE_PROMPTS = {
  formal: `你是「正式得體」回覆專家。給使用者 3 個版本，語氣專業、禮貌、措辭中性。適合：工作前輩、長輩、重要客戶、還沒很熟的對象。`,
  eq: `你是「高情商」回覆專家。給使用者 3 個版本，語氣溫暖、能讀懂對方背後的情緒。先安撫或共情，再回應。重點：給對方留面子、不掃興。適合：對方在抱怨、撒嬌、試探你的反應。`,
  wise: `你是「有智慧」回覆專家。給使用者 3 個版本，語言有深度、有隱喻或金句感。用簡短一句讓人回味。不浮誇、不油膩。適合：想讓對方覺得你「有想法」、不一般的人。`,
  humor: `你是「幽默風趣」回覆專家。給使用者 3 個版本，輕鬆、自嘲、會玩諧音或腦筋急轉彎。不低俗、不冒犯。讓對方笑出來或會心一笑。適合：朋友、戀人日常、化解尷尬。`,
  flirty: `你是「曖昧挑逗」回覆專家。給使用者 3 個版本，語氣曖昧、心跳感、留伏筆讓對方想回。不要太露骨、保持神秘與克制。適合：曖昧期、想升溫關係。`,
  custom: ``  // 自訂風格 prompt 會在下面拼接
};

function buildMessages(body) {
  const { style, her, ctx, customStyle, extras } = body;
  let sys = STYLE_PROMPTS[style] || STYLE_PROMPTS.formal;
  if (style === "custom") {
    const custom = (customStyle || "友善自然").trim();
    sys = `使用者要「${custom}」風格的回覆。給 3 個版本，每版一行直接寫出可用的訊息、不要解釋、不要編號標示。`;
  }
  let user = `對方訊息：「${(her || "").slice(0, 2000)}」`;
  if (ctx && ctx.trim()) user += `\n\n使用者的處境：${ctx.trim().slice(0, 500)}`;
  if (extras && extras.trim()) user += `\n\n使用者的修正要求：${extras.trim().slice(0, 500)}`;
  user += `\n\n請直接輸出 3 個版本，每個版本一行，不要解釋、不要前言。語言用繁體中文。`;
  return [
    { role: "system", content: sys },
    { role: "user", content: user }
  ];
}

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Reply-Token");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Token 驗證（如果有設 REPLY_TOKEN 環境變數）
  if (REPLY_TOKEN) {
    const clientToken = req.headers["x-reply-token"];
    if (clientToken !== REPLY_TOKEN) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  // 限流
  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "anon").split(",")[0].trim();
  if (!checkRate(ip)) {
    return res.status(429).json({ error: "Rate limit exceeded (5/min)" });
  }

  // 解析 body
  const body = req.body || {};
  const { model = "MiniMax-M3", messages } = body;
  let finalMessages = messages;
  if (!Array.isArray(messages)) {
    return res.status(400).json({ error: "messages array required" });
  }

  // 呼叫 MiniMax
  const apiKey = process.env.MINIMAX_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "Server not configured: MINIMAX_API_KEY missing" });
  }

  try {
    const r = await fetch("https://api.minimaxi.com/v1/text/chatcompletion_v2", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: model,
        messages: finalMessages,
        temperature: 0.95,
        max_tokens: 1024
      })
    });
    if (!r.ok) {
      const err = await r.text();
      return res.status(502).json({ error: "Upstream error", detail: err.slice(0, 1000) });
    }
    const data = await r.json();
    // Debug 版：把整個 upstream response 印出來
    if (!data.choices || data.choices.length === 0) {
      return res.status(502).json({ error: "No choices in response", raw: data });
    }
    const content = data.choices[0].message?.content || data.choices[0].text || "";
    return res.status(200).json({ content, usage: data.usage || null, raw_status: data.choices[0].finish_reason });
  } catch (e) {
    return res.status(500).json({ error: "Internal: " + e.message });
  }
};
