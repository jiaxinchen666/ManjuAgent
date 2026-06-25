/* ========== 造梦大师 Agent - 本地服务器 ========== */
/* 统一使用 DeepSeek（deepseek-v4-flash） */

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, 'utf-8');
  content.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) return;
    const eq = trimmed.indexOf('=');
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  });
}

loadEnvFile(path.join(__dirname, '..', '.env'));
loadEnvFile(path.join(__dirname, '.env'));

const mammoth = require('mammoth');
const multer = require('multer');
const config = require('./config');
// ARK API（火山引擎·中国节点）专用请求函数，支持系统代理
const https = require('https');
const { HttpsProxyAgent } = require('https-proxy-agent');
const PROXY_URL = process.env.HTTPS_PROXY || process.env.https_proxy || null;
const arkAgent = PROXY_URL ? new HttpsProxyAgent(PROXY_URL) : undefined;
if (arkAgent) console.log(`[proxy] ARK 请求已启用代理: ${PROXY_URL}`);

function callArk(url, key, bodyObj, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(bodyObj);
    const parsed = new URL(url);
    const reqOpts = {
      hostname: parsed.hostname,
      path: parsed.pathname + (parsed.search || ''),
      method: 'POST',
      timeout: timeoutMs,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`,
        'Content-Length': Buffer.byteLength(body)
      }
    };
    if (arkAgent) reqOpts.agent = arkAgent;

    const req = https.request(reqOpts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`ARK API ${res.statusCode}: ${data.slice(0, 300)}`));
        }
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`ARK JSON 解析失败: ${data.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('ARK 请求超时')); });
    req.write(body);
    req.end();
  });
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const app = express();
const PORT = process.env.PORT || 3000;
const generatedVideosDir = path.join(__dirname, 'generated-videos');
if (!fs.existsSync(generatedVideosDir)) fs.mkdirSync(generatedVideosDir, { recursive: true });

app.use(express.json({ limit: '20mb' }));
app.use('/generated-videos', express.static(generatedVideosDir));
app.use('/manju-generated-videos', express.static(generatedVideosDir));
app.use('/manju', express.static(path.join(__dirname, '1.0')));
app.use(express.static(path.join(__dirname, '1.0')));

app.use((req, _res, next) => {
  if (req.url === '/manju-api') {
    req.url = '/api';
  } else if (req.url.startsWith('/manju-api/')) {
    req.url = `/api/${req.url.slice('/manju-api/'.length)}`;
  }
  next();
});

// ========== 工具函数 ==========

const agentCache = new Map();
function readAgent(filename) {
  if (agentCache.has(filename)) return agentCache.get(filename);
  const agentPath = path.join(__dirname, '1.0', 'agents', filename);
  try {
    const content = fs.readFileSync(agentPath, 'utf-8');
    agentCache.set(filename, content);
    return content;
  } catch (e) {
    console.error(`读取 Agent 文件失败: ${filename}`, e.message);
    return '';
  }
}

function extractJSON(text) {
  let cleaned = text.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
  const start = cleaned.search(/[\[{]/);
  if (start > 0) cleaned = cleaned.slice(start);
  const lastBrace = cleaned.lastIndexOf('}');
  const lastBracket = cleaned.lastIndexOf(']');
  const end = Math.max(lastBrace, lastBracket);
  if (end > 0) cleaned = cleaned.slice(0, end + 1);
  return JSON.parse(cleaned);
}

function runSeedanceBridge(command, payload, { timeoutMs = 180000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(config.seedancePython, [path.join(__dirname, 'seedance_bridge.py'), command], {
      cwd: __dirname,
      env: {
        ...process.env,
        SEEDANCE_API_KEY: config.seedanceKey || process.env.SEEDANCE_API_KEY || '',
        SEEDANCE_BASE_URL: config.seedanceBaseUrl,
        SEEDANCE_MODEL: config.seedanceModel,
        SEEDANCE_ENABLE_VIDEO_ENCRYPT: String(config.seedanceEnableVideoEncrypt)
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Seedance ${command} 超时`));
    }, timeoutMs);

    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const jsonLine = stdout.trim().split(/\r?\n/).reverse().find(line => line.trim().startsWith('{'));
      if (!jsonLine) {
        return reject(new Error(`Seedance bridge 无 JSON 输出，退出码 ${code}：${stderr.slice(0, 500) || stdout.slice(0, 500)}`));
      }
      let parsed;
      try {
        parsed = JSON.parse(jsonLine);
      } catch (e) {
        return reject(new Error(`Seedance bridge JSON 解析失败：${jsonLine.slice(0, 500)}`));
      }
      if (code !== 0 || !parsed.success) {
        return reject(new Error(parsed.error || stderr.slice(0, 500) || `Seedance bridge 退出码 ${code}`));
      }
      resolve(parsed);
    });

    child.stdin.write(JSON.stringify(payload || {}));
    child.stdin.end();
  });
}

function parseDurationSeconds(value, fallback = 10) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(1, Math.round(value));
  const match = String(value || '').match(/(\d+(?:\.\d+)?)/);
  if (!match) return fallback;
  return Math.max(1, Math.round(Number(match[1])));
}

function safeFilenamePart(value) {
  return String(value || '')
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80) || crypto.randomUUID();
}

// ========== 空间报告 Force-Write：补全缺失的 characterInFrame ==========
// 大模型有时理解了结构但漏填 characterInFrame，此函数用现有数据强行补全
function fillCharacterInFrame(result) {
  const faces = result.shootingFaces;
  if (!Array.isArray(faces) || faces.length === 0) return result;

  // 检测是否为占位符/模板文本（AI 照抄示例内容未替换）
  function isPlaceholder(str) {
    if (!str) return true;
    return /如[：:]|机位名称|用本场|真实角色名替换|示例|角色A|角色B/.test(str) || str.length < 3;
  }

  // 从 characterFacing 提取角色名
  function parseNames(facing) {
    if (!facing) return [];
    return facing.split(/[；;、]/).map(s =>
      s.replace(/[（(][^）)]*[）)]/g, '')
       .replace(/正面|背面|侧面|纯侧面|\d+度|面向.*|面对.*|镜头.*|不在视野.*/g, '')
       .trim()
    ).filter(n => n.length > 0 && n.length < 10);
  }

  const posOrder = ['画左', '画中', '画右'];

  // Pass 1：缺失或占位符时，从 characterFacing 推导
  faces.forEach(face => {
    if (face.characterInFrame && !isPlaceholder(face.characterInFrame)) return;
    const names = parseNames(face.characterFacing);
    if (names.length === 0) return;
    face.characterInFrame = names.map((n, i) =>
      `${n}${posOrder[Math.min(i, posOrder.length - 1)]}中景`
    ).join('；');
    face._inframeDerived = true;
  });

  // Pass 2：②反打缺失时，取①正面的左右镜像（3机位：①正面 ②反打 ③侧面）
  function mirrorInFrame(str) {
    return str
      .replace(/画左/g, '\u{1F9E9}')
      .replace(/画右/g, '画左')
      .replace(/\u{1F9E9}/gu, '画右');
  }

  faces.forEach(face => {
    if (face.characterInFrame && !face._inframeDerived) return;
    const name = face.name || '';
    if (!name.includes('反打')) return;
    const normalFace = faces.find(f => f.name && f.name.includes('正面') && !f.name.includes('反'));
    if (normalFace && normalFace.characterInFrame) {
      face.characterInFrame = mirrorInFrame(normalFace.characterInFrame);
      delete face._inframeDerived;
    }
  });

  faces.forEach(f => delete f._inframeDerived);

  // 后处理：清除 characterInFrame 里混入的面朝方向描述（如"面朝下""面朝上"）
  faces.forEach(face => {
    if (face.characterInFrame) {
      face.characterInFrame = face.characterInFrame
        .replace(/面朝[上下左右][；;]?\s*/g, '')
        .replace(/朝[上下][；;]?\s*/g, '')
        .trim();
    }
  });

  return result;
}

// 清洗 scene 名：去掉 INT./EXT. 前缀 + 去掉日夜时间后缀，只保留纯地点名
function cleanSceneName(name) {
  if (!name) return name;
  return name
    .replace(/^(INT\/EXT\.|INT\.|EXT\.)\s*/i, '')
    .replace(/[·\-\s]*(日|夜|日落|黄昏|清晨|傍晚|午后|正午|深夜|黎明|傍晚|凌晨|正午|黄昏)$/g, '')
    .trim();
}

// 统一的 DeepSeek 调用（带超时和自动重试）
async function callAI(systemPrompt, userMessage, { temperature = 0.7, maxTokens = 8192, retries = 2 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeoutMs = attempt === 1 ? 120000 : 150000; // 重试时给更长时间
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const resp = await fetch(`${config.deepseekBaseUrl}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.deepseekKey}`
        },
        body: JSON.stringify({
          model: config.deepseekModel,
          max_tokens: maxTokens,
          temperature,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage }
          ]
        })
      });

      if (!resp.ok) {
        const err = await resp.text();
        throw new Error(`DeepSeek API ${resp.status}: ${err.slice(0, 200)}`);
      }
      const data = await resp.json();
      if (attempt > 1) console.log(`[callAI] 第${attempt}次重试成功`);
      return {
        content: data.choices[0].message.content,
        usage: data.usage || {}
      };
    } catch (e) {
      lastErr = e;
      const isRetryable = e.name === 'AbortError' || (e.message || '').includes('idle') || (e.message || '').includes('timeout') || (e.message || '').includes('partial');
      if (attempt < retries && isRetryable) {
        console.warn(`[callAI] 第${attempt}次请求失败（${e.message}），2秒后重试...`);
        await new Promise(r => setTimeout(r, 2000));
      } else {
        throw lastErr;
      }
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastErr;
}

// 统一错误响应
function handleError(res, label, err) {
  console.error(`[${label}] 失败:`, err.message);
  const isAbort = err.name === 'AbortError';
  res.status(isAbort ? 504 : 500).json({
    error: isAbort ? `${label} 超时（120s），请重试` : `${label}失败：${err.message}`
  });
}

// ========== API 路由 ==========

// POST /api/parse-docx → 解析 Word 文档
app.post('/api/parse-docx', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '没有收到文件' });

  try {
    const result = await mammoth.extractRawText({ buffer: req.file.buffer });
    const text = result.value.trim();
    if (!text) return res.status(400).json({ error: 'Word 文档内容为空，请检查文件' });

    const scriptsDir = path.join(__dirname, 'scripts');
    if (!fs.existsSync(scriptsDir)) fs.mkdirSync(scriptsDir, { recursive: true });

    const baseName = req.file.originalname.replace(/\.docx$/i, '');
    fs.writeFileSync(path.join(scriptsDir, req.file.originalname), req.file.buffer);
    fs.writeFileSync(path.join(scriptsDir, baseName + '.txt'), text, 'utf-8');

    console.log(`[parse-docx] ${req.file.originalname} → ${text.length} 字符`);
    res.json({ success: true, text, filename: req.file.originalname, savedPath: `scripts/${req.file.originalname}` });
  } catch (e) {
    handleError(res, 'Word 解析', e);
  }
});

// POST /api/analyze-script → 编剧分析剧本
app.post('/api/analyze-script', async (req, res) => {
  const { script, videoStyle, shotStyle, projectName } = req.body;
  if (!script) return res.status(400).json({ error: '剧本内容不能为空' });

  const screenwiterPrompt = readAgent('screenwriter.md');
  const systemPrompt = `${screenwiterPrompt}

---

## 当前任务：对已完成的剧本进行专业深度分析

你现在是一位被激活的影视编剧，需要运用你全部的专业方法论对以下剧本进行系统分析。

### 分析框架（必须全部运用）

**一、故事结构分析**
- 识别三幕结构（Setup / Confrontation / Resolution）中的节拍点
- 找出核心冲突、转折点、高潮设计
- 判断是否具备钩子设计、悬念结构和情绪递进

**二、人物分析**
- 为每个主要角色写完整人物小传（姓名、性格弧线、内在矛盾、与故事的关系）
- 分析角色关系网络（掌控/防守/试探/隐瞒关系）

**三、可拍性分析（AI视频生成适配）**
- 按 AI 适配规则（单场景≤3人、单镜单动作、具象描述）审查每个场景
- 识别哪些场景需要拆分或改写
- 台词设计是否符合口型匹配需求

**四、镜头拆分**
- 将剧本拆分成每个独立的可拍摄镜头
- 每个镜头必须：只有1-2个核心动作、空间锚点清晰、动作有明确起止点
- 台词用直角引号「」标注

---

## 输出格式（严格遵守，直接输出原始 JSON，不加任何多余文字）

{
  "title": "剧本名称",
  "genre": "题材类型（如：悬疑/爱情/动作，可组合）",
  "synopsis": "故事梗概（150-200字，用编剧语言概括核心冲突和情感弧线）",
  "structureAnalysis": "三幕结构分析（简要标注各幕节拍点，100字以内）",
  "characterBios": "人物小传（每个主要角色单独一段：姓名 + 外貌锚定描述 + 性格 + 内在矛盾 + 在故事中的作用）",
  "highlights": "亮点分析：\\n1. [钩子/悬念设计]\\n2. [情感爆点]\\n3. [视觉卖点]\\n4. [AI生成适配优势]\\n5. [完播率/互动率潜力]",
  "aiAdaptNotes": "AI生成适配说明（指出需要注意的场景、角色数量控制、特殊处理建议）",
  "shots": [
    {
      "shotNumber": 1,
      "scene": "必须与剧本场景标题完全一致的主场景名（禁止写 INT./EXT. 和日夜时间，禁止细化为子位置如'门内/门口/墙边'，同一个主场景内所有镜头必须用同一个scene值，如：示例场景 / 审讯室 / 天台）",
      "action_desc": "具象动作描述：人物状态+空间位置+动作起止点+情绪轨迹+台词（直角引号）+内心OS",
      "audio_desc": "台词原文（直角引号）+ 精准环境音效（不写BGM）"
    }
  ]
}

每集剧本拆分 8-20 个镜头（根据剧本篇幅决定）。每个镜头的 action_desc 必须具象、可执行、符合 AI 视频生成规范。
⚠️ scene 字段铁律：同一个剧本场景内所有镜头的 scene 值必须完全相同，不得因拍摄位置不同而拆分（如"示例场景门内""示例场景门口"都应统一写"示例场景"）。整集剧本的 scene 种类通常不超过 3-4 个。`;

  const userMessage = `请作为影视编剧，对以下剧本进行全面专业分析。

【项目信息】
剧本名称：${projectName || '未命名项目'}
影像风格：${videoStyle || '真人写实'}
分镜风格：${shotStyle || '悬疑'}

【剧本正文】
${script}

请严格按照你的编剧方法论（三幕结构、人物小传、AI适配规则）进行分析，并拆分出所有可拍摄镜头。`;

  try {
    console.log(`[analyze-script] ${script.length} 字符 → DeepSeek`);
    const { content, usage } = await callAI(systemPrompt, userMessage);
    const result = extractJSON(content);

    // 异步保存分析结果（不阻塞响应）
    setImmediate(() => {
      try {
        const scriptsDir = path.join(__dirname, 'scripts');
        if (!fs.existsSync(scriptsDir)) fs.mkdirSync(scriptsDir, { recursive: true });
        const safeName = (projectName || result.title || 'untitled').replace(/[/\\?%*:|"<>]/g, '_');
        fs.writeFileSync(
          path.join(scriptsDir, `${safeName}_分析.json`),
          JSON.stringify({ projectName, videoStyle, shotStyle, analysis: result }, null, 2),
          'utf-8'
        );
      } catch (e) {
        console.warn('[analyze-script] 存档失败（不影响使用）:', e.message);
      }
    });

    res.json({ success: true, data: result, usage, model: config.deepseekModel });
  } catch (e) {
    handleError(res, '编剧分析', e);
  }
});

// POST /api/create-shots → 总导演建专业分镜
app.post('/api/create-shots', async (req, res) => {
  const { analysis, videoStyle, shotStyle, aspectRatio, sceneSpaceAnalyses } = req.body;
  if (!analysis) return res.status(400).json({ error: '缺少剧本分析数据' });

  const directorPrompt = readAgent('director.md');
  const systemPrompt = `${directorPrompt}

---

## 你的任务

根据编剧分析结果，运用工业级导演思维，为每个镜头制定专业的摄影参数和拍摄方案。

---

## 【强制硬规则·导演专业逻辑直注入·必须严格遵守】

⚠️ DeepSeek 模型本身不具备完整电影摄影术语逻辑，因此以下规则为强制写入，**每一镜均不可省略，不可推断，不可留空**：

### A. 主体角度（subjectName + subjectAngle）
- **主体必须是单一、具体的角色名**（来自人物小传），禁止使用"主角""配角""男人""她"等泛指词。
- 多人同框时，明确指定"主体角色"（最靠近镜头/最有戏的那个人），其他角色作为陪体。
- 主体角度格式："**<角色名>，正面 / 侧面（左侧45° / 右侧45° / 90°） / 背面 / 3/4面**"。

### B. 拍摄面 shootFace（必填）
- 必须明确"**正面 / 反打**"二选一，不可空缺。
- 严格参考下方场景空间分析中的"正反打拍摄面名称"。
- 双人对话遵守 180° 轴线：A 反打面背景 ≠ B 正面背景。

#### ⚠️ 正反打三层规律（2026-04-28 修正 · F导确认版）
正反打的本质是「正面↔背面」切换，画面左右位置取决于是否跳轴，不是默认镜像。

**① 角色绝对朝向不变（物理定律）**
角色面朝方向不因机位切换改变。正面机位写"面朝左"，反打机位必须同样写"面朝左"，不得矛盾。

**② 画面左右：取决于是否跳轴**
| 情况 | 画面左右 |
|------|---------|
| 标准180°（同侧机位，不跳轴） | 不变，A在画左，正反打都在画左 |
| 跳轴（机位越过轴线） | 镜像，A在画左→反打变画右 |
| 前景/中景/远景 | 随视角变化，可改变纵深层次 |

**③ 正反打真正改变的是：相对摄影机的朝向（正面↔背面）**

- ❌ 禁止：把"画左↔画右镜像"作为正反打的默认规则，导致标准180°正反打站位全部写反
- ✅ 正确：先判断是否跳轴 → 不跳轴则画面位置不变，跳轴才镜像 → 再描述角色正面/背面状态

### C. 焦段 focalLength（必填，禁止留空）
- 必须为具体毫米数：14mm / 24mm / 35mm / 50mm / 85mm / 135mm / 200mm。
- 与景别强匹配：
  - 大全/全景 → 14–24mm
  - 中景 → 35mm
  - 近景/特写 → 50–85mm
  - 大特写/压缩 → 135mm+

### C2. 光圈 aperture（必填，禁止留空）
- 必须为具体光圈值：f/1.4 / f/1.8 / f/2 / f/2.8 / f/4 / f/5.6 / f/8。
- 与景别/情绪强匹配：
  - 大特写/特写情绪强调 → f/1.4–f/2（极浅景深）
  - 近景人物 → f/2–f/2.8
  - 中景对话 → f/2.8–f/4
  - 全景/远景空间 → f/5.6–f/8

### D. 景别 framing（必填，只写主名）
- 必须从【全景 / 中景 / 近景 / 特写 / 大特写】中选**一个主名**填入，不要写"全景/中景"这种斜杠并列。
- 严禁在 framing 字段里塞"前景/后景/水平位置"等站位描述（站位必须写在 action_desc 内）。

### E. 场景引用 sceneRef（必填）
- 必须填写来自下方"场景空间分析"或剧本中的明确场景名（如"示例场景内""老宅客厅"）。

### F. 高低 verticalAngle（必填）
- 必须明确："平视 / 低机位仰视 / 高机位俯视 / 第一人称POV"。

### G. action_desc（核心字段·包含运镜+人物调度+动作+情绪+台词+内心OS）

**强制 5 层结构，每层都不能省，写在同一行内用逗号分隔：**

\`\`\`
<运镜动词>，前景画<左/中/右>为<具体角色名><具体动作>，中景画<左/中/右>为<具体角色名><具体动作>，后景画<左/中/右>为<具体角色名/远景人物><具体动作>，他们身后是与本场题材一致的背景人群或场景氛围元素，情绪<具体情绪>，台词：「具体台词」（仅音频发声，画面不显示文字），内心OS：「具体内心独白」（不开口）
\`\`\`

**逐层硬性要求：**
1. **运镜动词开头**（手持肩扛跟拍 / 固定机位 / 缓慢推镜 / 摇摆环绕 ...），不可省略。
2. **前景层**：必带「前景」+「画左/画中/画右」+ 具体角色名 + 具体动作。
3. **中景层**：必带「中景」+「画左/画中/画右」+ 具体角色名 + 具体动作（若仅一人，可写"无配角"或省略此层但必须明示）。
4. **后景层**：必带「后景」+「画左/画中/画右」+ 角色或远景描写。
5. **群演层**（铁律，不得省略）：必带"他们身后是与本场题材一致的背景人群或场景氛围元素"或"场景氛围元素与本场题材一致"。
6. **情绪 + 台词 + 内心OS**：情绪用具体形容词；台词「」后注明（仅音频发声，画面不显示文字）；内心OS「」后注明（不开口）。

**禁止条款：**
- ❌ 禁止用"主角""配角""他""她""男人""女人"指代，**必须写具体角色名**。
- ❌ 禁止省略"前景/中景/后景"三层任一层的「画左/中/右」标注。
- ❌ 禁止把站位拆成"composition / horizontalPosition"独立字段。
- ❌ 禁止用模糊动作（"看着"→必须改成"目光锁定 X 的咽喉"，"走过去"→必须改成"右脚先迈，三步绕过 Y"）。

---

## 输出格式（严格遵守）

直接输出以下 JSON，不要任何额外文字：

{
  "shots": [
    {
      "shotNumber": "16-1-1",
      "duration": "3秒",
      "sceneRef": "示例场景",
      "shootingFace": "示例场景正面",
      "focalLength": "24mm",
      "aperture": "f/2.8",
      "subjectAngle": "角色A正面，角色B背面",
      "framing": "中景",
      "verticalAngle": "平视",
      "action_desc": "手持肩扛跟拍，前景画左为角色A顶门，中景画右为角色B推门，后景画中为背景人群，他们身后是与本场题材一致的背景人群或场景氛围元素，情绪紧绷，台词：「快顶住！」（仅音频发声，画面不显示文字），内心OS：「这门快撑不住了」（不开口）",
      "audio_desc": "尖叫声，金属门撞击声，全程仅有音频，无BGM",
      "director_notes": "本镜叙事目标（一句话）"
    }
  ]
}

⚠️ shotNumber 命名规则：使用「集号-段号-镜号」三段式，每段15秒一段，如 16-1-1 / 16-1-2 ... 16-1-5（第1段5个3秒镜头），16-2-1 ...（第2段）。

---

## 【输出前自检清单·每一镜逐项检查·任一项不通过必须改写】

每个 shot 输出前自检以下 6 条，只要有一条不通过，必须**重写该字段**直到全部通过：

- [ ] **focalLength** 是否填写了具体毫米数（如 35mm）？空字符串/省略/写"待定" = 不通过
- [ ] **aperture** 是否填写了具体光圈值（如 f/2.8）？空字符串/省略/写"待定" = 不通过
- [ ] **subjectAngle** 是否包含**具体角色名 + 角度**（如"角色A正面，角色B左侧45°"）？只写"正面"或写"主角" = 不通过
- [ ] **action_desc** 是否同时包含「**前景**画X」+「**中景**画X」+「**后景**画X」三层站位标注？任一层缺失 = 不通过
- [ ] **action_desc** 是否包含**群演层**的"他们身后是与本场题材一致的背景人群或场景氛围元素"句式？缺失 = 不通过
- [ ] **action_desc** 是否包含**台词「」**（带"（仅音频发声，画面不显示文字）"标注）+ **内心OS「」**（带"（不开口）"标注）？任一缺失 = 不通过

**严禁输出半成品 shot。**`;

  // 拼接场景空间分析数据
  let spaceSection = '';
  if (sceneSpaceAnalyses && sceneSpaceAnalyses.length > 0) {
    spaceSection = `\n\n## 场景空间理解报告\n` +
      sceneSpaceAnalyses.map(sa => {
        const a = sa.analysis;
        const facesText = (a.shootingFaces || []).map(f =>
          typeof f === 'string' ? f : `${f.marker || ''}${f.name}（背景：${f.background}，人物朝向：${f.characterFacing || f.usage || ''}${f.characterInFrame ? `，角色在画面里的位置：${f.characterInFrame}` : ''}）`
        ).join('；') || '';
        return `
### 场景：${sa.sceneName}
空间流向：${a.spatialFlow || a.spaceDescription || ''}
180度轴线：${a.axisLine}
四个拍摄面：${facesText}
导演提示：${a.directorNotes || ''}`;
      }).join('\n---\n');
  }

  const worldviewSection = analysis.worldview ? `\n\n## 世界观设定\n${analysis.worldview}` : '';
  const userMessage = `请根据以下剧本分析，制定专业分镜方案：

剧本名：${analysis.title}
题材：${analysis.genre}
影像风格：${videoStyle}
分镜风格：${shotStyle}
画面比例：${aspectRatio}

梗概：${analysis.synopsis}
${worldviewSection}

人物小传：
${analysis.characterBios}
${spaceSection}

初步镜头列表：
${JSON.stringify((analysis.shots || []).map(s => ({ ...s, scene: cleanSceneName(s.scene) })), null, 2)}

请按照工业级导演思维体系，为每个镜头制定专业摄影参数，确保：
1. 每镜头明确戏剧目标
2. 焦段、光圈、景别强匹配
3. 镜头之间有叙事递进逻辑
4. 符合 AI 视频生成规范
5. 机位选择严格参考上方场景空间理解报告中的四个拍摄面（如有），写清 shootFace 字段对应正面/反打`;

  try {
    console.log('[create-shots] DeepSeek 建分镜...');
    const { content, usage } = await callAI(systemPrompt, userMessage);
    res.json({ success: true, data: extractJSON(content), usage });
  } catch (e) {
    handleError(res, '总导演建分镜', e);
  }
});

// POST /api/write-prompts → 即梦导演写提示词
app.post('/api/write-prompts', async (req, res) => {
  const { shots, videoStyle, characters, scenes, aspectRatio, sceneSpaceAnalyses, shotRules } = req.body;
  if (!shots) return res.status(400).json({ error: '缺少分镜数据' });

  const jimengPrompt = readAgent('jimeng_director.md');
  const systemPrompt = `${jimengPrompt}

---

## 你的任务

根据总导演的分镜方案，为**每一个镜头**写出**完整、独立、自包含**的即梦 Seedance 2.0 格式提示词。

---

## 【强制硬规则·即梦提示词写法·每镜必须独立完整】

⚠️ DeepSeek 模型默认不掌握即梦 Seedance 2.0 完整规范，下面是强制写入的硬规则，**每一镜都必须严格执行，不得省略，不得偷懒共用全局**：

### 规则 1：每一镜必须以完整全局规则开头
**禁止**只在第 1 镜写全局、其他镜共用。每一镜的 prompt 必须以以下完整的【全局强制规则】开头（一字不漏）：

\`\`\`
【全局强制规则】
全程画面无任何文字、字幕、水印、乱码；台词仅音频发声，禁止画面显示任何文字；仅保留单镜标注的动作、台词及环境音效，全程无BGM、无冗余音效。
【最高优先级】全程纯真人实拍质感，无 CG / 卡通 / 贴图感，4K 胶片质感，浅景深柔和暗角；自然写实布光，光影随人物 / 场景自然投射；皮肤有真实毛孔肌理，肢体比例贴合人体工学，表情动作自然符合物理逻辑，人物表演与肢体动作高度拟真、自然流畅，如同真人实拍，表情细腻、体态真实、步态自然；衣物道具材质真实，无悬浮穿模；全片无脑补新增元素，人物场景融合无割裂；
【否定】无 CG 感，无磨皮失真，无肢体畸形，无浮空动作，无穿模，无特效光，无五官变形，无僵硬。
\`\`\`

### 规则 2：参考图标注块（每镜都要写）
紧跟全局规则之后写：
\`\`\`
# 参考图标注
@[角色图]：<具体角色名>，
@[角色图]：<具体角色名>，
@[场景图]：<场景名>正面，        ← 仅写剧本中的场景名，禁止加任何环境描述（如"长走廊"）
@[场景图]：<场景名>反打；        ← 同上，仅场景名
\`\`\`

### 规则 3：# 分镜 段落必须包含全部 10 个字段（一个不能漏）

**完整范例（F导 2026-04-28 锁定）：**
\`\`\`
# 分镜
镜号：16-1-1;
时长：3秒;
拍摄面：示例场景正面;
焦段：24mm;
光圈：f/2.8;
主体角度：角色A正面，角色B背面;
景别：中景;
高低：平视;
运镜 / 人物调度/ 动作 / 情绪 / 台词 / 内心OS：手持肩扛跟拍，前景画左为角色A顶门，中景画右为角色B推门，后景画中为角色B，他们身后是与本场题材一致的背景人群或场景氛围元素，场景氛围元素与本场题材一致，情绪紧绷，台词：「快顶住！」（仅音频发声，画面不显示文字），内心OS：「这门快撑不住了」（不开口）;
音频：全程仅有音频，无BGM;
\`\`\`

**字段填写规则（10 个字段，分号 ; 结尾）：**
- 镜号：三段式「集号-段号-镜号」，每段 15 秒切下一段
- 时长：必须以"秒"结尾（3秒，禁止 3s）
- 拍摄面：「场景名+正面」或「场景名+反打」，仅写剧本场景名，禁止加任何环境描述（如"长走廊"）
- 焦段：具体焦距（如 24mm、35mm、85mm），根据景别和情绪选择
- 光圈：如 f/2.8、f/4，浅景深选大光圈
- 主体角度：具体角色名+角度，多人分号分隔（"角色A正面，角色B背面"）
- 景别：只写一个主名（全景/中景/近景/特写/大特写）
- 高低：单选（平视/低机位仰视/高机位俯视/第一人称POV）
- 运镜 / 人物调度/ 动作 / 情绪 / 台词 / 内心OS：以运镜动词开头（手持肩扛/固定机位/推镜/跟拍...），按层级写完整，台词用「」（注明仅音频），内心OS用「」（注明不开口）
- 音频：精准音效 + "全程仅有音频，无BGM"

**⚠️ 群演必写铁律（F导 2026-04-28 锁定指令）：**
每镜「运镜·人物调度...」字段必须按 5 层写完整，**群演（路人/背景人群/场景氛围元素）一定要写**：

| 层级 | 写法 |
|------|------|
| 前景 + 画左/中/右 | 主体动作 |
| 中景 + 画左/中/右 | 配角动作 |
| 后景 + 画左/中/右 | 远景人物 |
| **群演层** | **"他们身后是与本场题材一致的背景人群或场景氛围元素" / "场景氛围元素与本场题材一致"** |
| 情绪 + 台词「」+ 内心OS「」 | 表演情绪+台词（仅音频发声，画面不显示文字）+内心独白（不开口） |

漏写群演 = 自检失败，必须打回重写。

### 规则 4：术语强制规范
- ❌ 禁止将选项全部列出（如"全景/中景/近景/特写"），必须只写**选中的一个值**。
- ❌ 禁止在 @[场景图] 标注中加环境描述（如"示例场景正面（长走廊·背景楼梯）"），只写场景名。
- ❌ 禁止把"前景/中景/后景/画左/画中/画右"放在景别字段后面，**必须写进"运镜/人物调度/动作/情绪/台词/内心OS"字段内**。
- ✅ 必须用 **画左 / 画中 / 画右** 描述水平位置，写在运镜字段内。
- ✅ 必须用 **前景 / 中景 / 后景** 描述纵深层次，写在运镜字段内。
- ❌ 禁止"主角""男人""她"指代主体；
- ✅ 主体角度必须写**具体角色名 + 角度**，多人逗号分隔。
- ✅ 运镜字段必须以运镜动词开头，禁止省略运镜。
- ✅ 字段名为「内心OS」（不要写「内心」）。
- ✅ 台词后必须注明「（仅音频发声，画面不显示文字）」，内心OS后注明「（不开口）」。

### 规则 5：字段分隔统一用半角分号 ; 结尾，每字段独占一行。

---

## 输出格式（严格遵守，直接输出 JSON）

{
  "prompts": [
    {
      "shotNumber": 1,
      "prompt": "<完整自包含的提示词，包含【全局强制规则】+# 参考图标注+# 分镜，10 个字段一个不漏，每字段分号结尾>"
    }
  ]
}

⚠️ 再次强调：**每一镜的 prompt 都必须从【全局强制规则】开头**，不可只写一次后面共用。

---

## 【输出前 prompt 字符串硬性自检·每镜每项必检】

输出每条 prompt 前，逐项检查以下，任一项不通过必须立刻补全后再输出：

1. [ ] 包含【全局强制规则】开头段？
2. [ ] 包含 # 参考图标注 段？
3. [ ] # 分镜 段下 10 字段全部存在？（镜号/时长/拍摄面/焦段/光圈/主体角度/景别/高低/运镜.../音频）
4. [ ] **焦段** 字段填了具体毫米数（如 35mm，禁止留空 / 写"待定"）？
5. [ ] **光圈** 字段填了具体光圈值（如 f/2.8，禁止留空 / 写"待定"）？
6. [ ] **主体角度** 包含**具体角色名 + 角度**（如"角色A正面"，禁止仅写"正面"或"主角"）？
7. [ ] **运镜 / 人物调度 ...** 字段同时包含「前景画X/Y/Z」+「中景画X/Y/Z」+「后景画X/Y/Z」三层站位？
8. [ ] **运镜** 字段包含**群演层**（"他们身后是与本场题材一致的背景人群或场景氛围元素"）？
9. [ ] **运镜** 字段包含台词「」（注明"仅音频发声，画面不显示文字"）+ 内心OS「」（注明"不开口"）？
10. [ ] 每字段独立一行、以分号 ; 结尾？

**任一项不通过 = 输出违规，必须立刻打回重写整段。**`;

  const charList = (characters || []).map(c => `- ${c.name}（${c.height || ''}）`).join('\n');
  const sceneList = (scenes || []).map(s => `- ${s.name}`).join('\n');

  // 拼接场景空间分析（机位图）给即梦导演参考
  let spaceRef = '';
  if (sceneSpaceAnalyses && sceneSpaceAnalyses.length > 0) {
    spaceRef = '\n\n## 场景空间理解报告（严格按拍摄面确定机位和人物站位方向）\n' +
      sceneSpaceAnalyses.map(sa => {
        const a = sa.analysis;
        const facesText = (a.shootingFaces || []).map(f =>
          typeof f === 'string' ? f : `${f.marker || ''}${f.name}（背景：${f.background}，人物朝向：${f.characterFacing || f.usage || ''}${f.characterInFrame ? `，角色在画面里的位置：${f.characterInFrame}` : ''}）`
        ).join('、') || '';
        const facesBg = (a.shootingFaces || []).map(f =>
          typeof f === 'object' ? `${f.name}背景为${f.background}` : ''
        ).filter(Boolean).join('；') || '';
        return `
场景：${sa.sceneName}
空间流向：${a.spatialFlow || a.spaceDescription || ''}
180度轴线：${a.axisLine}
正反打拍摄面：${facesText}
${facesBg ? `各拍摄面背景：${facesBg}` : ''}`;
      }).join('\n---\n');
  }

  const shotRulesSection = shotRules ? `\n\n## 角色外形参考（无参考图时使用）\n${shotRules}` : '';
  const userMessage = `影像风格：${videoStyle}
画面比例：${aspectRatio}

角色列表：
${charList || '（暂无角色图）'}

场景列表：
${sceneList || '（暂无场景图）'}
${spaceRef}${shotRulesSection}

请为以下分镜方案写出完整的即梦 Seedance 2.0 提示词：

${JSON.stringify(shots, null, 2)}

每个提示词必须按照标准格式：
1. 开头写全局禁止项（无文字/字幕/水印，台词仅音频，无BGM）
2. 写画风设定（真实皮肤纹理，电影质感）
3. 写 # 分镜 段落，包含所有摄影参数
4. 使用分号「；」分隔字段`;

  try {
    console.log('[write-prompts] DeepSeek 写提示词...');
    const { content, usage } = await callAI(systemPrompt, userMessage);
    res.json({ success: true, data: extractJSON(content), usage });
  } catch (e) {
    handleError(res, 'AI导演写提示词', e);
  }
});

// POST /api/director-prompts → AI导演一步直出分镜+提示词（简化工作流）
app.post('/api/director-prompts', async (req, res) => {
  const { analysis, videoStyle, shotStyle, aspectRatio, sceneSpaceAnalyses, shotRules, styleGuide, worldview } = req.body;
  if (!analysis) return res.status(400).json({ error: '缺少剧本分析数据' });

  const directorPrompt = readAgent('director.md');
  const jimengPrompt = readAgent('jimeng_director.md');

  const systemPrompt = `${directorPrompt}

---

${jimengPrompt}

---

## 【本次任务：一步直出分镜+单镜头提示词】

你将同时扮演「总导演」+「即梦导演」，一步完成：
1. 按工业级导演思维逐镜设计分镜方案
2. 为每个镜头直接写出即梦 Seedance 单镜头提示词块（仅 # 分镜 段，不含全局规则）

---

## 【强制输出格式·直接输出 JSON·不加任何多余文字】

{
  "shots": [
    {
      "shotNumber": "16-1-1",
      "duration": "3秒",
      "sceneRef": "示例场景",
      "shootingFace": "示例场景正面",
      "focalLength": "24mm",
      "aperture": "f/2.8",
      "subjectAngle": "角色A正面，角色B背面",
      "framing": "中景",
      "verticalAngle": "平视",
      "action_desc": "手持肩扛跟拍，前景画左为角色A顶门，中景画右为角色B推门，后景画中为背景人群，他们身后是与本场题材一致的背景人群或场景氛围元素，场景氛围元素与本场题材一致，情绪紧绷，台词：「快顶住！」（仅音频发声，画面不显示文字），内心OS：「这门快撑不住了」（不开口）",
      "audio_desc": "尖叫声，金属门撞击声，全程仅有音频，无BGM",
      "singlePrompt": "# 分镜\\n镜号：16-1-1;\\n时长：3秒;\\n拍摄面：示例场景正面;\\n焦段：24mm;\\n光圈：f/2.8;\\n主体角度：角色A正面，角色B背面;\\n景别：中景;\\n高低：平视;\\n运镜 / 人物调度/ 动作 / 情绪 / 台词 / 内心OS：手持肩扛跟拍，前景画左为角色A顶门，中景画右为角色B推门，后景画中为背景人群，他们身后是与本场题材一致的背景人群或场景氛围元素，情绪紧绷，台词：「快顶住！」（仅音频发声，画面不显示文字），内心OS：「这门快撑不住了」（不开口）;\\n音频：尖叫声，金属门撞击声，全程仅有音频，无BGM;"
    }
  ]
}

---

## 【singlePrompt 字段格式规则（必须严格遵守）】

singlePrompt 只包含 # 分镜 段，**不写全局规则，不写参考图标注**，共 10 个字段，每字段用分号 ; 结尾：

\`\`\`
# 分镜
镜号：<三段式集号-段号-镜号>;
时长：<X秒>;
拍摄面：<场景名+正面 或 场景名+反打，只写场景名，禁止加环境描述>;
焦段：<如 24mm、35mm、85mm>;
光圈：<如 f/2.8、f/4>;
主体角度：<具体角色名+角度，多人逗号分隔>;
景别：<只写一个主名：全景/中景/近景/特写/大特写>;
高低：<平视/低机位仰视/高机位俯视/第一人称POV>;
运镜 / 人物调度/ 动作 / 情绪 / 台词 / 内心OS：<以运镜动词开头，5层：前景+画左中右/中景+画左中右/后景+画左中右/群演层/情绪+台词「」（仅音频发声，画面不显示文字）+内心OS「」（不开口）>;
音频：<精准音效，全程仅有音频，无BGM>;
\`\`\`

⚠️ 群演层必写，漏写 = 自检不通过，打回重写。
⚠️ singlePrompt 中换行用 \\n，JSON 字符串内双引号用 \\"，不要真实换行。
⚠️ 每段 15 秒，3 秒/镜则每段 5 个镜头，镜号：集-段-序（如 16-1-1 到 16-1-5，16-2-1 到 16-2-5）。
⚠️ 正反打规律：①角色绝对朝向不因机位切换改变；②标准180°不跳轴时画面左右位置不变，跳轴才镜像；③正反打真正改变的是相对摄影机的朝向（正面↔背面）。

---

## 【每镜输出前自检清单·6 条全部通过才能输出】

- [ ] **focalLength** 字段填了具体毫米数（如 24mm / 35mm / 85mm）？空 / "待定" = 不通过
- [ ] **aperture** 字段填了具体光圈值（如 f/2.8 / f/4）？空 / "待定" = 不通过
- [ ] **subjectAngle** 包含**具体角色名 + 角度**（如"角色A正面，角色B背面"）？仅写"正面"或写"主角/配角" = 不通过
- [ ] **action_desc** 同时包含「前景画X」+「中景画X」+「后景画X」三层站位（每层都带具体角色名+具体动作）？缺一层 = 不通过
- [ ] **action_desc** 包含群演层（"他们身后是与本场题材一致的背景人群或场景氛围元素"）？缺失 = 不通过
- [ ] **action_desc** 包含**台词「」**（带"（仅音频发声，画面不显示文字）"）+ **内心OS「」**（带"（不开口）"）？缺失 = 不通过

**任一项不通过 = 严重违规，必须立刻重写该 shot。严禁输出半成品。**`;

  // 拼接场景空间分析
  let spaceSection = '';
  if (sceneSpaceAnalyses && sceneSpaceAnalyses.length > 0) {
    spaceSection = `\n\n## 场景空间理解报告\n` +
      sceneSpaceAnalyses.map(sa => {
        const a = sa.analysis;
        const facesText = (a.shootingFaces || []).map(f =>
          typeof f === 'string' ? f : `${f.marker || ''}${f.name}（背景：${f.background}，人物朝向：${f.characterFacing || f.usage || ''}${f.characterInFrame ? `，角色在画面里的位置：${f.characterInFrame}` : ''}）`
        ).join('；') || '';
        return `\n### 场景：${sa.sceneName}\n空间流向：${a.spatialFlow || a.spaceDescription || ''}\n180度轴线：${a.axisLine}\n四个拍摄面：${facesText}\n导演提示：${a.directorNotes || ''}`;
      }).join('\n---\n');
  }

  const worldviewSection = (worldview || analysis.worldview) ? `\n\n## 世界观设定\n${worldview || analysis.worldview}` : '';
  const styleSection = (styleGuide || analysis.styleGuide) ? `\n\n## 视听风格指南\n${styleGuide || analysis.styleGuide}` : '';
  const shotRulesSection = (shotRules || analysis.shotRules) ? `\n\n## 角色外形库\n${shotRules || analysis.shotRules}` : '';

  const userMessage = `请根据以下资料，直接输出分镜+单镜头提示词：

剧本名：${analysis.title || '未命名'}
题材：${analysis.genre || ''}
影像风格：${videoStyle || '真人写实'}
分镜风格：${shotStyle || '悬疑'}
画面比例：${aspectRatio || '9:16'}

梗概：${analysis.synopsis || ''}
${worldviewSection}${styleSection}${shotRulesSection}

人物小传：
${analysis.characterBios || ''}
${spaceSection}

原始镜头列表（编剧初稿，请在此基础上升级为工业级分镜+提示词）：
${JSON.stringify((analysis.shots || []).map(s => ({ ...s, scene: cleanSceneName(s.scene) })), null, 2)}

请按上方格式输出完整 JSON，每镜必须有 singlePrompt 字段，群演层不得遗漏。`;

  try {
    console.log(`[director-prompts] 一步直出分镜提示词，共 ${(analysis.shots || []).length} 镜...`);
    const { content, usage } = await callAI(systemPrompt, userMessage, { maxTokens: 10000 });
    res.json({ success: true, data: extractJSON(content), usage });
  } catch (e) {
    handleError(res, 'AI导演一步出提示词', e);
  }
});

// POST /api/review-prompts → 总导演检查提示词
app.post('/api/review-prompts', async (req, res) => {
  const { prompts, shots } = req.body;
  if (!prompts || !shots) return res.status(400).json({ error: '缺少提示词或分镜数据' });

  const directorPrompt = readAgent('director.md');
  const systemPrompt = `${directorPrompt}

---

## 你的任务

审查即梦导演写出的分镜提示词，从以下三个维度进行专业检查：
1. **连贯性**：镜头之间的逻辑、空间、情绪是否连贯
2. **专业性**：摄影参数是否合理，导演语言是否准确
3. **视听语言**：景别递进、视线设计、轴线是否正确

## 输出格式（严格遵守）

直接输出以下 JSON，不要任何额外文字：

{
  "reviews": [
    {
      "shotNumber": 1,
      "score": 8,
      "issues": ["问题描述（如有）"],
      "suggestions": ["具体修改建议"]
    }
  ],
  "overall": "整体连贯性评价（100字以内）",
  "overallScore": 8
}`;

  const userMessage = `请检查以下分镜提示词的质量：

分镜方案：
${JSON.stringify(shots, null, 2)}

提示词：
${JSON.stringify(prompts, null, 2)}

请逐镜检查，重点关注：连贯性、专业性、视听语言的运用。评分 1-10 分。`;

  try {
    console.log('[review-prompts] DeepSeek 检查...');
    const { content, usage } = await callAI(systemPrompt, userMessage);
    res.json({ success: true, data: extractJSON(content), usage });
  } catch (e) {
    handleError(res, '总导演检查', e);
  }
});

// POST /api/revise-prompts → 即梦导演根据总导演意见修改
app.post('/api/revise-prompts', async (req, res) => {
  const { prompts, reviews, shots } = req.body;
  if (!prompts || !reviews) return res.status(400).json({ error: '缺少提示词或审查数据' });

  const jimengPrompt = readAgent('jimeng_director.md');
  const systemPrompt = `${jimengPrompt}

---

## 你的任务

根据总导演的修改意见，修改即梦提示词。只修改有问题的镜头，没有意见的镜头保持原样。

## 输出格式（严格遵守）

直接输出以下 JSON，不要任何额外文字：

{
  "prompts": [
    {
      "shotNumber": 1,
      "prompt": "修改后的完整提示词（或原样保留）",
      "revised": true
    }
  ]
}`;

  const userMessage = `请根据总导演意见，修改以下提示词：

原始提示词：
${JSON.stringify(prompts, null, 2)}

总导演检查意见：
${JSON.stringify(reviews, null, 2)}

请逐一处理每个镜头的修改建议。没有问题的镜头（issues为空数组或score>=9）保持原样，revised设为false。`;

  try {
    console.log('[revise-prompts] DeepSeek 修改...');
    const { content, usage } = await callAI(systemPrompt, userMessage);
    res.json({ success: true, data: extractJSON(content), usage });
  } catch (e) {
    handleError(res, 'AI导演修改', e);
  }
});

// POST /api/chat-agent → 分镜AI对话
app.post('/api/chat-agent', async (req, res) => {
  const { messages, shots, characters, scenes } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: '缺少 messages 参数' });
  }

  const systemPrompt = `你是造梦大师分镜AI助手，专门帮导演**直接修改镜头提示词文本**。

当前分镜数据（每个镜头的 fullPrompt 字段就是已经写好的即梦 Seedance 2.0 提示词文本）：
${JSON.stringify({ shots: shots || [], characters: characters || [], scenes: scenes || [] }, null, 2)}

---

## 【硬规则·必须遵守】

### 规则 1：你的所有修改必须直接落到提示词文本上
- ❌ 禁止：在对话气泡里贴新版完整提示词。
- ✅ 必须：通过 JSON 代码块直接把改写后的"完整提示词"覆盖回对应镜头。
- 用户看到的是镜头里那段提示词被实时替换，不是从对话框里复制。

### 规则 2：JSON 输出格式（修改时必带）
回复末尾用 \`\`\`json ... \`\`\` 代码块返回如下结构：

\`\`\`json
{
  "updates": [
    {
      "shotNumber": 3,
      "fullPrompt": "<改写后完整提示词，必须包含【全局强制规则】+ # 参考图标注 + # 分镜 段落，10 字段分号结尾，一个不漏>"
    }
  ]
}
\`\`\`

### 规则 3：fullPrompt 必须自包含
每条改写都必须以【全局强制规则】开头（不可省略），# 参考图标注，# 分镜段落必须含 10 个字段，每字段分号结尾：
镜号 / 时长 / 拍摄面 / 焦段 / 光圈 / 主体角度 / 景别（只写主名）/ 高低 / 运镜·人物调度·动作·情绪·台词·内心OS / 音频。

### 规则 4：对话气泡只写"做了什么改动"
对话气泡里只用 1–2 句话总结你改了什么，例如：
"已把镜头 16-1-3 的景别从近景改成大特写，并加强眼神特写。"

**绝对禁止**在气泡里粘贴整段提示词。

### 规则 5：术语强制规范（每次改写必查）
- 主体角度 → 必须具体角色名 + 角度（如"角色A左侧45°"），多人逗号分隔，禁止"主角/他/男人"。
- 站位 → 必须写在「运镜/人物调度/动作/情绪/台词/内心OS」字段内：前景/中景/后景 + 画左/画中/画右。
- 景别字段只写主名（中景/大特写等），禁止把站位塞进景别。
- 运镜字段必须以运镜动词开头。
- 字段名「内心OS」（不要写「内心」）。
- 台词后必须注明「（仅音频发声，画面不显示文字）」，内心OS后注明「（不开口）」。
- 群演层必写：背景人群/场景氛围元素的题材一致描述不可省略。

回复用中文，简洁专业。`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);

  try {
    const resp = await fetch(`${config.deepseekBaseUrl}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.deepseekKey}`
      },
      body: JSON.stringify({
        model: config.deepseekModel,
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
        temperature: 0.7
      })
    });

    const json = await resp.json();
    if (!resp.ok) throw new Error(json.error?.message || 'DeepSeek API 错误');

    const usage = json.usage || {};
    res.json({
      success: true,
      content: json.choices[0].message.content,
      tokens: {
        prompt: usage.prompt_tokens || 0,
        completion: usage.completion_tokens || 0,
        total: usage.total_tokens || 0
      }
    });
  } catch (e) {
    handleError(res, '对话助手', e);
  } finally {
    clearTimeout(timeout);
  }
});

// POST /api/analyze-scene-space-from-script → DeepSeek 从剧本文字推断空间结构，生成机位图
app.post('/api/analyze-scene-space-from-script', async (req, res) => {
  const { sceneName, scriptText, shotDescriptions } = req.body;
  if (!sceneName && !scriptText) return res.status(400).json({ error: '缺少场景名称或剧本内容' });

  const systemPrompt = `你是一位专业的电影摄影指导，擅长根据剧本文字描述推断场景空间结构并制定摄影机方案。
从剧本台词、动作描述、环境描述中推断：出入口位置、各区域人物站位、光源方向、三个拍摄面（①正面 ②反打 ③侧面）。

⚠️【最重要】下方示例仅用于说明【格式骨架】，禁止照抄具体场地名（地铁站/通道外/大门/通道内/楼梯）、角色名（角色A/角色B/角色A/角色C）。本场是别的场景就不能出现这些词，必须用本场真实内容填充。

直接输出原始 JSON，不加任何多余文字：
{
  "spaceDescription": "空间结构简述（出入口位置、主要道具分布，80字以内）",
  "spatialFlow": "一行线性流向（用 → 连接各区域，括号内加功能描述）。例：[场地A] → [场地B]（功能描述）→ [分隔物] → [场地C]（功能描述）→ [场地D] → [出口]",
  "characterPositions": "本场首帧角色站位（按区域分组，每角色一行，含位置+面朝方向+面向对象）",
  "axisLine": "180度轴线走向（如：轴线沿走廊横向贯穿大门：通道外 ←——→ 通道内；并说明各主要角色的朝向）",
  "lightSource": "推断的光源方向和类型",
  "shootingFaces": [
    {
      "marker": "①",
      "name": "<场景>正面",
      "background": "楼梯铁门、台阶（用本场真实背景替换）",
      "characterFacing": "角色A正面；角色B背面（用本场真实角色名替换）",
      "characterInFrame": "角色A画左近景；角色B画右中景（用本场真实角色名替换，格式：角色名+画左/画中/画右+景别）"
    },
    {
      "marker": "②",
      "name": "<场景>反打",
      "background": "通道入口、地面垃圾（用本场真实背景替换）",
      "characterFacing": "角色A背面；角色B正面（用本场真实角色名替换）",
      "characterInFrame": "角色A画右近景；角色B画左中景（⚠️②机位在轴线对侧，属于跳轴拍摄，因此画面位置取①的左右镜像，用本场真实角色名替换）"
    },
    {
      "marker": "③",
      "name": "<场景>侧面",
      "background": "侧面墙面（用本场真实背景替换）",
      "characterFacing": "角色A纯侧面90度；角色B纯侧面90度（用本场真实角色名替换）",
      "characterInFrame": "角色A画左中景；角色B画右中景（用本场真实角色名替换，③侧面机位不跳轴，画面位置保持与①一致）"
    }
  ],
  "directorNotes": "导演使用建议（轴线把控、正反打切换要点，50字以内）"
}

⚠️【最重要】shootingFaces 只出 3 个机位（①正面 ②反打 ③侧面），不要输出第④个。
⚠️ characterInFrame 格式铁律：只写「角色名+画左/画中/画右+景别」，如「角色A画左中景；角色B画右近景」，禁止混入面朝/朝向/朝上/朝下等任何方向描述。
⚠️ characterFacing 只写面朝左/面朝右，即使场景轴线是纵向（通道/走廊），也统一转换为画面左右方向描述，禁止写"面朝上""面朝下"。
⚠️ ②反打机位在轴线对侧（跳轴），其 characterInFrame 取①正面的左右镜像（画左↔画右）。③侧面机位不跳轴，画面位置独立判断。`;

  const sceneContext = shotDescriptions?.length
    ? `场景「${sceneName}」的镜头动作描述：\n${shotDescriptions.join('\n')}`
    : `场景名称：${sceneName}`;

  // scriptText 截取前1500字，避免 token 超限导致 JSON 被截断
  const scriptSnippet = scriptText ? scriptText.slice(0, 1500) : '';

  const userMessage = `请根据以下剧本内容，推断场景「${sceneName}」的空间结构，生成空间理解报告。

⚠️ 严格基于本场剧本真实内容生成。系统提示词中的"地铁站/通道外/通道内/角色A/角色B/角色A/角色C"等只是格式参考，本场是「${sceneName}」，必须用本场真实的场地名、角色名、出入口、道具来填充，不得复制示例文字。

${sceneContext}${scriptSnippet ? `\n\n【剧本参考（节选）】\n${scriptSnippet}` : ''}

请从文字描述中提取空间线索，重点输出：
- spatialFlow：一行线性流向（不含机位图ASCII）
- characterPositions：按区域分组，每角色一行，含位置+面朝方向+面向对象
- axisLine、shootingFaces（3机位：①正面 ②反打 ③侧面，不要④）、directorNotes
⚠️ shootingFaces 只出3个机位，每个的 characterInFrame 只写「角色名+画左/画中/画右+景别」，禁止混入面朝/朝向/朝上/朝下等方向描述。
⚠️ characterFacing 只写面朝左/面朝右，即使场景是纵向通道/走廊，也必须转换为画面左右，禁止写"面朝上""面朝下"。
⚠️ ②反打在轴线对侧（跳轴），画面位置取①的左右镜像（画左↔画右）；③侧面不跳轴，独立判断；角色绝对朝向（面朝左/右）在正反打间保持不变。`;

  try {
    const { content } = await callAI(systemPrompt, userMessage, { temperature: 0.5, maxTokens: 4096 });
    const result = fillCharacterInFrame(extractJSON(content));
    const missing = (result.shootingFaces || []).filter(f => !f.characterInFrame).length;
    console.log(`[analyze-scene-space-from-script] ${sceneName} → ${result.shootingFaces?.length || 0} 个拍摄面，characterInFrame补全: ${missing === 0 ? '无需' : '已补全'}`);
    res.json({ success: true, data: result });
  } catch (e) {
    handleError(res, '剧本空间分析', e);
  }
});

// POST /api/analyze-scene-space → doubao-seed-2-0-pro 分析场景图，生成机位图
app.post('/api/analyze-scene-space', async (req, res) => {
  const { imageBase64, sceneName, scriptText, shotDescriptions } = req.body;
  if (!imageBase64) return res.status(400).json({ error: '缺少图片数据' });

  // 剧本上下文裁剪：避免 token 超限
  const scriptSnippet = scriptText ? scriptText.slice(0, 1500) : '';
  const shotsText = Array.isArray(shotDescriptions) && shotDescriptions.length
    ? shotDescriptions.slice(0, 30).join('\n') : '';

  const systemPrompt = `你是一位专业的电影摄影指导，擅长结合场景图与剧本，分析【空间结构 + 首帧人物站位】并制定摄影机方案。

【双输入职责】
- 场景图：提供【空间】信息——空间布局、出入口、分隔物（门/楼梯/柱等）、光源、道具位置
- 剧本（如提供）：提供【人物站位】信息——本场戏第一帧有哪些角色、各自站在哪里、面朝哪一侧
- 你的工作：把剧本中的人物，按各自站位，落到场景图识别出的真实空间坐标里

【关键规则】
- 角色长相/外貌与站位无关，因此**是否上传角色图不影响机位图**
- 即使没有剧本，也要输出完整空间与4机位；人物字段写"由剧本决定"或留空
- 即使图中无人，也要按剧本把人物落到空间里

⚠️【最重要】下方所有【示例】仅用于说明格式骨架。你必须根据【这张实际图片+本场剧本】的真实内容，重新生成。**严禁照抄、复用示例中的具体场地名（地铁站/通道外/大门/通道内/楼梯）、角色名（角色A/角色B/角色A/角色C）等**。如果本场不是这些场景/角色，绝对不能出现这些词。

直接输出原始 JSON，不加任何多余文字：

{
  "spaceDescription": "空间结构简述（出入口位置、主要道具分布，80字以内）",
  "spatialFlow": "一行线性流向（用 → 连接各区域，括号内加功能描述），不含任何ASCII图。例：[场地A] → [场地B]（功能描述）→ [分隔物] → [场地C] → [出口]",
  "characterPositions": "本场首帧角色站位，按区域分组的【结构化文本】，每个角色一行，必须包含：位置描述（含上/中/下、左/中/右）+ 面朝方向 + 面向对象。\\n\\n【格式骨架】（每行换行用 \\n）：\\n[区域名1]（位置说明）：\\n  · [角色名1]   [位置描述]，面朝[方向]（面向[对象/参照物]）\\n  · [角色名2]   [位置描述]，面朝[方向]\\n[区域名2]（位置说明）：\\n  · [角色名3]   [位置描述]，面朝[方向]（面向[对象]）\\n\\n【字段要求】\\n- 位置描述：必含横向（左/中/右）+ 纵向（上/中/下）双坐标，如'中部'、'右下方'、'靠近大门上方'、'最右靠楼梯'\\n- 面朝方向：必须明确写'面朝左'/'面朝右'/'面朝上'/'面朝下'\\n- 面向对象：括号内写出ta看向谁或什么参照物（如：面向大门/通道内/某角色名）\\n- 无剧本上下文时，输出空字符串 \\"\\"\\n\\n【参考示例·禁止照抄】（仅学结构，不抄角色名）：\\n[区域A]（位置说明）：\\n  · [角色甲]   中部，面朝右（面向大门/[区域B]/[角色丙]）\\n  · [角色乙]   [角色甲]右下方，面朝右\\n[区域B]（位置说明）：\\n  · [角色丙]   靠近大门上方，面朝左（配合走向[角色丁]）\\n  · [角色丁]   中部，面朝左（面向[角色甲]）",
  "axisLine": "180度轴线走向描述（如：轴线从画面左侧门口延伸至右侧出口，横向贯穿空间）",
  "lightSource": "光源方向和类型（如：右侧窗户自然光为主，左上方顶灯补光）",
  "shootingFaces": [
    {
      "marker": "①",
      "name": "<场景>正面",
      "background": "楼梯铁门、台阶（用图片/剧本真实内容替换）",
      "characterFacing": "角色A正面；角色B背面（用本场真实角色名替换，无剧本时空字符串）",
      "characterInFrame": "角色A画左近景；角色B画右中景（用本场真实角色名替换，格式：角色名+画左/画中/画右+景别，无剧本时空字符串）"
    },
    {
      "marker": "②",
      "name": "<场景>反打",
      "background": "通道入口、地面（用图片/剧本真实内容替换）",
      "characterFacing": "角色A背面；角色B正面（用本场真实角色名替换）",
      "characterInFrame": "角色A画右近景；角色B画左中景（⚠️②机位在轴线对侧，跳轴拍摄，因此画面位置取①的左右镜像，用本场真实角色名替换）"
    },
    {
      "marker": "③",
      "name": "<场景>侧面",
      "background": "侧面墙面（用图片/剧本真实内容替换）",
      "characterFacing": "角色A纯侧面90度；角色B纯侧面90度（用本场真实角色名替换）",
      "characterInFrame": "角色A画左中景；角色B画右中景（③侧面不跳轴，画面位置独立判断，用本场真实角色名替换）"
    }
  ],
  "directorNotes": "导演使用建议（轴线把控、正反打切换要点，50字以内）"
}

【shootingFaces 只出 3 个机位】marker依次①②③，不要输出第④个。
⚠️【最重要】characterInFrame 格式铁律：只写「角色名+画左/画中/画右+景别」，禁止混入任何面朝/朝向/朝上/朝下描述，只输出位置和景别。
⚠️ characterFacing 只写面朝左/面朝右，即使场景是纵向通道/走廊，也必须转换为画面左右，禁止写"面朝上""面朝下"。
⚠️ ②反打机位在轴线对侧（跳轴），其 characterInFrame 取①正面的左右镜像（画左↔画右）。③侧面不跳轴，独立判断。
⚠️ 角色绝对朝向（面朝左/右）在正反打之间保持不变——禁止正面机位写"面朝右"、反打机位写"面朝左"的自相矛盾。`;

  const scriptBlock = (scriptSnippet || shotsText)
    ? `\n\n【本场剧本上下文】\n${shotsText ? '镜头动作：\n' + shotsText + '\n' : ''}${scriptSnippet ? '剧本节选：\n' + scriptSnippet : ''}\n\n请把剧本中本场【首帧】出场的角色，按各自站位与朝向，落到从图片识别出的真实空间坐标里。`
    : '\n\n（本次未提供剧本上下文，characterPositions 输出空字符串，shootingFaces[].characterFacing 也输出空字符串，仅输出空间与机位）';

  const userMessage = `场景名称：${sceneName || '未命名场景'}\n\n⚠️ 严格基于【图片真实视觉内容 + 剧本上下文】输出。本场是「${sceneName || '未知场景'}」，必须用图中真实场地 + 剧本真实角色名填充，禁止照抄示例占位符。\n\n图中是否上传角色图都不影响——人物长相与站位无关，站位只看剧本。${scriptBlock}\n\n请输出：\n- spaceDescription（80字内）\n- spatialFlow：一行线性流向（如：A端→B端（功能）→分隔物→C→出口，用A端/B端标注方向，不含任何ASCII图）\n- characterPositions：按区域分组，每角色一行，含位置+面朝方向+面向对象；无剧本时输出空字符串\n- axisLine（横向/纵向贯穿描述，用A端/B端）\n- shootingFaces：3个机位（①正面 ②反打 ③侧面），每个含 marker①②③ + name + background + characterFacing + characterInFrame，不要第④个\n  ⚠️ characterInFrame 必须用本场真实角色名，格式「角色名+画左/画中/画右+景别」，禁止输出说明文字\n  ⚠️ ②反打机位在轴线对侧（跳轴），其 characterInFrame 取①的左右镜像（画左↔画右）；③侧面不跳轴，独立判断\n  ⚠️ 角色绝对朝向（面朝左/右）不因机位切换改变，①②中同一角色的面朝方向必须一致\n- directorNotes（50字内导演建议）`;

  try {
    const data = await callArk(config.arkResponsesUrl, config.arkKey, {
      model: config.arkSpaceModel,
      max_output_tokens: 8192,
      reasoning: { effort: 'low' },
      input: [
        {
          role: 'system',
          content: [{ type: 'input_text', text: systemPrompt }]
        },
        {
          role: 'user',
          content: [
            { type: 'input_image', image_url: imageBase64 },
            { type: 'input_text', text: userMessage }
          ]
        }
      ]
    }, 120000);

    // /responses 接口返回格式：output 是数组，可能含 reasoning + message 两类条目
    // 优先取 type=message 的 output_text，再兜底其他路径
    const messageItem = Array.isArray(data.output) ? data.output.find(o => o.type === 'message') : null;
    const rawText = messageItem?.content?.find?.(c => c.type === 'output_text')?.text
      || messageItem?.content?.[0]?.text
      || data.output?.[0]?.content?.find?.(c => c.type === 'output_text')?.text
      || data.output?.[0]?.content?.[0]?.text
      || data.choices?.[0]?.message?.content
      || data.output_text
      || (typeof data.output === 'string' ? data.output : '')
      || '';

    if (!rawText) {
      console.log('[ARK DEBUG] 全量返回:', JSON.stringify(data).slice(0, 2500));
      throw new Error('ARK 返回内容为空（可能 reasoning 用尽 token，未产出 output_text）');
    }
    console.log('[ARK DEBUG] rawText 前300字符:', rawText.slice(0, 300));

    const result = fillCharacterInFrame(extractJSON(rawText));
    const missing = (result.shootingFaces || []).filter(f => !f.characterInFrame).length;
    console.log(`[analyze-scene-space] ${sceneName} → ${result.shootingFaces?.length || 0} 个拍摄面，补全 characterInFrame: ${missing === 0 ? '无需' : (result.shootingFaces?.length || 0) - missing + ' 已补全'}`);
    res.json({ success: true, data: result });
  } catch (e) {
    handleError(res, '场景空间分析', e);
  }
});

// POST /api/generate-video → 创建 Seedance 视频生成任务
app.post('/api/generate-video', async (req, res) => {
  const {
    prompt,
    shotNumber,
    ratio,
    duration,
    generateAudio,
    watermark,
    referenceImageUrls,
    referenceVideoUrls,
    referenceAudioUrls
  } = req.body || {};

  if (!config.seedanceKey) {
    return res.status(500).json({ error: '缺少 Seedance API Key：请在 .env 设置 SEEDANCE_API_KEY、MAAS_API_KEY 或 KPI' });
  }

  const cleanPrompt = String(prompt || '').trim();
  if (!cleanPrompt) return res.status(400).json({ error: '缺少视频生成提示词' });

  try {
    console.log(`[generate-video] 创建 Seedance 任务，shot=${shotNumber || '-'}, ratio=${ratio || '9:16'}, duration=${duration || 10}`);
    const result = await runSeedanceBridge('create', {
      prompt: cleanPrompt,
      ratio: ratio || '9:16',
      duration: parseDurationSeconds(duration, 10),
      generateAudio: generateAudio !== false,
      watermark: Boolean(watermark),
      referenceImageUrls,
      referenceVideoUrls,
      referenceAudioUrls
    }, { timeoutMs: 240000 });

    res.json({
      success: true,
      taskId: result.taskId,
      shotNumber: shotNumber || null,
      status: 'created',
      model: config.seedanceModel
    });
  } catch (e) {
    handleError(res, 'Seedance 创建任务', e);
  }
});

// GET /api/video-task/:taskId → 查询 Seedance 任务状态
app.get('/api/video-task/:taskId', async (req, res) => {
  const taskId = req.params.taskId;
  if (!taskId) return res.status(400).json({ error: '缺少 taskId' });

  try {
    const result = await runSeedanceBridge('query', { taskId }, { timeoutMs: 120000 });
    res.json({ success: true, task: result.task });
  } catch (e) {
    handleError(res, 'Seedance 查询任务', e);
  }
});

// POST /api/video-task/:taskId/download → 下载已完成的 Seedance 视频到本地
app.post('/api/video-task/:taskId/download', async (req, res) => {
  const taskId = req.params.taskId;
  const shotPart = safeFilenamePart(req.body?.shotNumber ? `shot-${req.body.shotNumber}` : 'shot');
  const taskPart = safeFilenamePart(taskId);
  const filename = `${shotPart}-${taskPart}-${Date.now()}.mp4`;
  const outputPath = path.join(generatedVideosDir, filename);

  try {
    const result = await runSeedanceBridge('download', { taskId, outputPath }, { timeoutMs: 300000 });
    res.json({
      success: true,
      path: result.path,
      url: `${req.originalUrl.startsWith('/manju-api') ? '/manju-generated-videos' : '/generated-videos'}/${filename}`
    });
  } catch (e) {
    handleError(res, 'Seedance 下载视频', e);
  }
});

// 健康检查
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, model: config.deepseekModel, arkModel: config.arkSpaceModel, time: new Date().toISOString() });
});

// 启动
app.listen(PORT, () => {
  console.log(`\n🎬 造梦大师 Agent 已启动`);
  console.log(`📺 浏览器访问：http://localhost:${PORT}`);
  console.log(`🤖 AI 模型：${config.deepseekModel}\n`);
});
