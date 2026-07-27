// api/reply.js - Vercel Serverless Function
// API Key 由 Vercel 環境變數 MINIMAX_API_KEY 提供
// 呼叫者只能看到「訊息 → 收到 3 個版本」，看不到 Key
//
// 環境變數（在 Vercel 後台設定）:
//   MINIMAX_API_KEY  ← 你的 MiniMax API key
//   REPLY_TOKEN      ← 簡單的呼叫 token（防止公開亂用）
//
// 安全設計:
//   - Prompt 組裝統一在後端 (前端只傳參數, 改 Prompt 策略只需改後端)
//   - 錯誤訊息不回傳 detail 原始內容 (前端只拿友善訊息, 完整 log 在 Vercel)
//   - 限流每分鐘每 IP 5 次
//   - Token 驗證可選

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const REPLY_TOKEN = process.env.REPLY_TOKEN || "";

// 限流
const rateLimit = new Map();
const RATE_LIMIT_PER_MIN = 5;

function checkRate(ip) {
  const now = Date.now();
  const rec = rateLimit.get(ip) || { count: 0, window: now };
  if (now - rec.window > 60000) {
    rec.count = 0;
    rec.window = now;
  }
  rec.count++;
  rateLimit.set(ip, rec);
  return rec.count <= RATE_LIMIT_PER_MIN;
}

// 風格 Prompt 字典（後端統一管理）
const STYLE_PROMPTS = {
  formal: `你是「正式得體」回覆專家。給使用者 3 個版本，語氣專業、禮貌、措辭中性。適合：工作前輩、長輩、重要客戶、還沒很熟的對象。`,
  eq: `你是「高情商」回覆專家。給使用者 3 個版本，語氣溫暖、能讀懂對方背後的情緒。先安撫或共情，再回應。重點：給對方留面子、不掃興。適合：對方在抱怨、撒嬌、試探你的反應。`,
  wise: `你是「有智慧」回覆專家。給使用者 3 個版本，語言有深度、有隱喻或金句感。用簡短一句讓人回味。不浮誇、不油膩。適合：想讓對方覺得你「有想法」、不一般的人。`,
  humor: `你是「幽默風趣」回覆專家。給使用者 3 個版本，輕鬆、自嘲、會玩諧音或腦筋急轉彎。不低俗、不冒犯。讓對方笑出來或會心一笑。適合：朋友、戀人日常、化解尷尬。`,
  flirty: `你是「曖昧挑逗」回覆專家。給使用者 3 個版本，語氣曖昧、心跳感、留伏筆讓對方想回。不要太露骨、保持神秘與克制。適合：曖昧期、想升溫關係。`,
};

// 標籤化情境 Prompt
const TAG_PROMPTS = {
  flavored: "對方是曖昧對象，想升溫關係、語氣自然親密、不過頭。",
  work: "對方是工作關係(主管/客戶/同事)，語氣專業得體、乾淨不油。",
  family: "對方是家人或長輩，語氣尊敬、保守、孝順。",
  friend: "對方是普通朋友，語氣輕鬆自在、像聊天。",
  strangers: "對方不太熟，語氣禮貌、保留、不誇張。",
};

// Prompt 組裝（後端統一做）
function buildMessages(body) {
  const { style, her, ctx, customStyle, extras, tags } = body;
  let sys = STYLE_PROMPTS[style] || STYLE_PROMPTS.formal;

  // 自訂風格
  if (style === "custom") {
    const custom = (customStyle || "友善自然").trim();
    sys = `使用者要「${custom}」風格的回覆。給 3 個版本，每版一行直接寫出可用的訊息、不要解釋、不要編號標示。`;
  }

  // 標籤化情境（多選, 串接）
  let tagAddition = "";
  if (Array.isArray(tags) && tags.length > 0) {
    const additions = tags.map(t => TAG_PROMPTS[t]).filter(Boolean);
    if (additions.length > 0) {
      tagAddition = `\n\n[情境背景] ${additions.join(" ")}`;
    }
  }

  let user = `對方訊息：「${(her || "").slice(0, 2000)}」`;
  if (ctx && ctx.trim()) user += `\n\n使用者的處境：${ctx.trim().slice(0, 500)}`;
  if (extras && extras.trim()) user += `\n\n使用者的修正要求：${extras.trim().slice(0, 500)}`;
  user += tagAddition;
  user += `\n\n請依序輸出兩部分，用以下標籤嚴格分隔（注意必須有完整 3 行版本，不要把第 3 行寫成括號內的解釋說明）：

<INSIGHT>1~2 句話分析對方這句話的表面意思、潛台詞、情緒狀態（撒嬌/抱怨/試探/緊張/冷淡…等），以及建議用哪種風格回應最合適</INSIGHT>

<VERSIONS>
第一行：版本 1
第二行：版本 2
第三行：版本 3
</VERSIONS>

每個版本必須是「直接可貼給對方的訊息」一行（不超過 60 字）。風格要符合「${sys.split('，')[0]}」。語言用繁體中文。不要編號標示、不要括號註解。`;

  return [
    { role: "system", content: sys },
    { role: "user", content: user },
  ];
}

// 完整回應解析（拆解 INSIGHT + VERSIONS）
function parseFullResponse(text) {
  if (!text) return { insight: null, versions: [] };

  let insight = null;
  let body = text;

  // 1. 嘗試拆 <INSIGHT> 標籤
  const insightMatch = text.match(/<INSIGHT>([\s\S]*?)<\/INSIGHT>/i);
  if (insightMatch) {
    insight = insightMatch[1].trim();
    body = text.replace(/<INSIGHT>[\s\S]*?<\/INSIGHT>/i, "").trim();
  }

  // 2. 嘗試拆 <VERSIONS> 標籤
  const versionsMatch = body.match(/<VERSIONS>([\s\S]*?)<\/VERSIONS>/i);
  if (versionsMatch) {
    body = versionsMatch[1].trim();
  }

  // 3. 解析 3 個版本
  const lines = body.split(/\n+/).map(l => l.trim()).filter(l => l.length > 0);
  let versionTexts = [];
  if (lines.length >= 3) {
    versionTexts = lines.slice(0, 3);
  } else {
    // 4. fallback: 按數字標點分割
    const numbered = body.split(/\s*[1-3][\.\)、]\s*/).map(l => l.trim()).filter(l => l.length > 5);
    if (numbered.length >= 3) {
      versionTexts = numbered.slice(0, 3);
    } else {
      // 5. fallback: 按句號分割
      const sentences = body.split(/(?<=[。！？!?])\s*/).filter(l => l.length > 5);
      if (sentences.length >= 3) {
        versionTexts = sentences.slice(0, 3);
      } else {
        versionTexts = body.length > 0 ? [body] : [];
      }
    }
  }

  // 過濾掉仍是標籤殘留的版本
  versionTexts = versionTexts
    .map(t => t.replace(/^<VERSIONS>|<\/VERSIONS>$/gi, "").trim())
    .filter(t => t.length > 0 && !/^<[A-Z]+>$/.test(t));

  // 過濾掉像「（...）」這種解釋性括號開頭的行（AI 偶爾會把第 3 版寫成解釋說明）
  versionTexts = versionTexts.filter(t => {
    const trimmed = t.trim();
    // 純括號開頭且結尾 - 視為解釋說明，剔除
    if (/^[（(].*[）)]$/.test(trimmed) && !/[一-龥]/.test(trimmed.slice(1, -1).replace(/[（()）]/g, ''))) {
      return false;
    }
    return true;
  });

  // 確保至少 1 個版本
  if (versionTexts.length === 0 && body.length > 0) {
    versionTexts = [body.replace(/^<VERSIONS>|<\/VERSIONS>$/gi, "").trim()];
  }

  return {
    insight: insight,
    versions: versionTexts
  };
}

// 標籤決策（自動給每版加上標籤）
function autoTagVersion(text) {
  const len = text.length;
  const hasEmoji = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{27BF}]/u.test(text);
  const hasBut = /但是|但|然而|其實|倒是/.test(text);
  const hasLen = len > 50;

  if (len < 25) return "精簡";
  if (hasEmoji) return "俏皮";
  if (hasLen && hasBut) return "細膩";
  if (hasLen) return "完整";
  if (hasBut) return "轉折";
  return "平實";
}

// 友善錯誤訊息（不洩漏內部細節）
function friendlyError(status, kind) {
  const map = {
    config: "伺服器設定不完整，請聯繫管理員。",
    upstream: "AI 服務暫時無法回應，請稍後再試。",
    invalid_key: "API 金鑰問題，請聯繫管理員。",
    rate_limit: "請求太頻繁，請稍候再試。",
    empty: "AI 沒有回應，請重新生成。",
    method: "不支援的請求方式。",
    auth: "驗證失敗。",
    bad_request: "請求格式不對。",
  };
  return map[kind] || "請求失敗，請稍後再試。";
}

// Server-side log（不會回傳前端）
function log(level, msg, extra) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] ${msg}`;
  if (extra) {
    console.log(line, JSON.stringify(extra));
  } else {
    console.log(line);
  }
}

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Reply-Token");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: friendlyError(405, "method") });
  }

  // Token 驗證
  if (REPLY_TOKEN) {
    const clientToken = req.headers["x-reply-token"];
    if (clientToken !== REPLY_TOKEN) {
      log("warn", "Unauthorized token", { ip: req.headers["x-forwarded-for"] });
      return res.status(401).json({ error: friendlyError(401, "auth") });
    }
  }

  // 限流
  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "anon")
    .split(",")[0].trim();
  if (!checkRate(ip)) {
    return res.status(429).json({ error: friendlyError(429, "rate_limit") });
  }

  // API Key 檢查
  const apiKey = process.env.MINIMAX_API_KEY;
  if (!apiKey) {
    log("error", "MINIMAX_API_KEY missing");
    return res.status(500).json({ error: friendlyError(500, "config") });
  }

  // 解析 body
  const body = req.body || {};
  const { model = "MiniMax-M3", her, ctx, style = "formal", customStyle, extras, tags } = body;

  // 必須有對方訊息
  if (!her || !her.trim()) {
    return res.status(400).json({ error: "請先貼上對方訊息" });
  }

  // 組裝 messages（後端統一做，前端不需管）
  const messages = buildMessages(body);

  // 呼叫 MiniMax（多端點 fallback）
  const endpoints = [
    "https://api.minimax.io/v1/text/chatcompletion_v2",
    "https://api.minimax.io/v1/chat/completions",
  ];

  for (const url of endpoints) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: model,
          messages: messages,
          temperature: 0.95,
          max_tokens: 2048  // 提高上限避免 AI 寫到一半被切
        })
      });

      if (!r.ok) {
        const errText = await r.text();
        // 詳細 log 在 server, 不回傳前端
        log("warn", "Upstream error", { endpoint: url, status: r.status, body: errText.slice(0, 500) });

        // 2049 = invalid api key → 換下一個 endpoint
        if (errText.includes("2049")) {
          if (url === endpoints[endpoints.length - 1]) {
            // 兩個 endpoint 都說 invalid → 真的是 key 問題
            log("error", "Invalid API key on all endpoints");
            return res.status(502).json({ error: friendlyError(502, "invalid_key") });
          }
          continue;
        }

        // 其他錯誤, 給前端友善訊息, 保留 trace ID 供 debugging
        const traceId = `err_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        log("error", "Upstream failure", { traceId, endpoint: url, detail: errText.slice(0, 500) });
        return res.status(502).json({
          error: friendlyError(502, "upstream"),
          traceId: traceId,
        });
      }

      const data = await r.json();
      if (!data.choices || data.choices.length === 0) {
        log("warn", "No choices in response", { endpoint: url });
        continue;
      }

      const content = data.choices[0].message?.content || data.choices[0].text || "";
      if (!content) {
        log("warn", "Empty content", { endpoint: url });
        continue;
      }

      // 解析完整回應（拆解 INSIGHT + VERSIONS）
      const parsed = parseFullResponse(content);
      const versions = parsed.versions.map(text => ({
        text: text,
        tag: autoTagVersion(text),
        charCount: text.length,
      }));

      log("info", "Success", {
        endpoint: url,
        hasInsight: !!parsed.insight,
        versionCount: versions.length
      });

      return res.status(200).json({
        versions: versions,
        insight: parsed.insight,  // 新欄位：心理解讀
        usage: data.usage || null,
      });
    } catch (e) {
      log("error", "Fetch exception", { endpoint: url, error: e.message });
      continue;
    }
  }

  // 全部 endpoint 都失敗
  return res.status(502).json({ error: friendlyError(502, "empty") });
};
