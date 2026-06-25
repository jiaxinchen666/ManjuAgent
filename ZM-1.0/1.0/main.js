/* ========== 造梦大师 Agent - 主逻辑 ========== */

const MANJU_ROUTE_PREFIX = window.location.pathname === '/manju' || window.location.pathname.startsWith('/manju/');
const API_BASE = MANJU_ROUTE_PREFIX ? '/manju-api' : '/api';

function apiPath(path) {
  return `${API_BASE}${path.startsWith('/') ? path : `/${path}`}`;
}

// ============ 首页逻辑 ============
function initHomePage() {
  // 首页不再加载任何预置项目，保持完全空白的新建入口。
}

async function loadPresetProject() {
  navigateTo('new-project');
  showToast('预置项目已关闭，请上传或粘贴新剧本', 'warning');
}

// 同步 new-project 页面 UI（无剧本时使用）
function _syncNewProjectUI() {
  const nameEl = document.getElementById('projectName');
  if (nameEl) nameEl.value = AppState.projectName;
  ['videoStyleGroup', 'shotStyleGroup'].forEach(gid => {
    const g = document.getElementById(gid);
    if (!g) return;
    g.querySelectorAll('.tag-btn').forEach(b => {
      const match = (gid === 'videoStyleGroup') ? AppState.videoStyle : AppState.shotStyle;
      b.classList.toggle('active', b.dataset.value === match);
    });
  });
}

// 预填 script-analysis 页面（有剧本但未AI分析时）
function _prefillScriptAnalysisPage() {
  document.getElementById('analysisTitle').value        = AppState.projectName;
  document.getElementById('analysisGenre').value        = AppState.analysis.genre || '';
  document.getElementById('analysisVideoStyle').value   = AppState.videoStyle;
  document.getElementById('analysisShotStyle').value    = AppState.shotStyle;
  document.getElementById('analysisSynopsis').value     = '';
  document.getElementById('analysisStructure').value    = '';
  document.getElementById('analysisCharBios').value     = AppState.analysis.characterBios || '';
  document.getElementById('analysisHighlights').value   = '';
  document.getElementById('analysisAiAdapt').value      = '';
  document.getElementById('analysisOriginal').value     = AppState.scriptText;
  // 画面比例选中
  document.querySelectorAll('#aspectRatioGroup .tag-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.value === AppState.aspectRatio);
  });
  // 隐藏资产区（没有跑过分析）
  const assetsSection = document.getElementById('analysisAssetsSection');
  if (assetsSection) assetsSection.classList.add('hidden');
  // 显示"未分析"横幅
  const banner = document.getElementById('analysisReadyBanner');
  if (banner) banner.classList.remove('hidden');
}

// 从 script-analysis 页面直接触发 AI 编剧分析
async function handleAnalyzeFromPage() {
  const script = AppState.scriptText || AppState.analysis.originalScript;
  if (!script || script.trim().length < 50) {
    showToast('剧本内容太短，无法分析', 'error');
    return;
  }
  const apiKey = getApiKey();
  if (AppState.plan !== 'A' && !apiKey) { navigateTo('settings'); return; }

  // 隐藏横幅，开始加载
  const banner = document.getElementById('analysisReadyBanner');
  if (banner) banner.classList.add('hidden');

  showFullscreenLoading('编剧 Agent 正在深度解析剧本结构、人物小传与镜头拆分...');

  try {
    const resp = await fetch(apiPath('/analyze-script'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        script,
        videoStyle: AppState.videoStyle,
        shotStyle: AppState.shotStyle,
        projectName: AppState.projectName,
        apiKey,
        plan: AppState.plan,
        model: 'deepseek'
      })
    });

    const json = await resp.json();
    if (!resp.ok) throw new Error(json.error || '分析失败');

    const result = json.data;
    AppState.analysis = { ...AppState.analysis, ...result, originalScript: script };
    AppState.hasAnalysis = true;

    document.getElementById('analysisTitle').value        = result.title || AppState.projectName;
    document.getElementById('analysisGenre').value        = result.genre || '';
    document.getElementById('analysisVideoStyle').value   = AppState.videoStyle;
    document.getElementById('analysisShotStyle').value    = AppState.shotStyle;
    document.getElementById('analysisSynopsis').value     = result.synopsis || '';
    document.getElementById('analysisStructure').value    = result.structureAnalysis || '';
    document.getElementById('analysisCharBios').value     = result.characterBios || '';
    document.getElementById('analysisHighlights').value   = result.highlights || '';
    document.getElementById('analysisAiAdapt').value      = result.aiAdaptNotes || '';
    document.getElementById('analysisOriginal').value     = script;

    Object.assign(WorkflowState, {
      step1Done: false, step2Done: false, step3Done: false, step4Done: false,
      shots: [], prompts: [], reviews: null
    });

    updateAnalysisSaveCost();
    autoGenerateAssetsFromAnalysis(result);
    hideFullscreenLoading();
    showToast(`✓ AI 编剧分析完成，已拆分 ${(result.shots || []).length} 个镜头`, 'success');
  } catch (e) {
    hideFullscreenLoading();
    if (banner) banner.classList.remove('hidden');
    showToast('分析失败：' + e.message, 'error');
  }
}

// ============ 全局状态 ============
const AppState = {
  credits: 100000,
  creditsUsed: 0,
  currentPage: 'home',
  projectName: '',
  videoStyle: '真人写实',
  shotStyle: '悬疑',
  aspectRatio: '16:9',
  scriptText: '',
  isLoggedIn: true,
  plan: 'A', // 默认方案A，服务器自带DeepSeek Key
  hasAnalysis: false,
  analysis: {
    title: '',
    genre: '',
    synopsis: '',
    characterBios: '',
    highlights: '',
    originalScript: '',
    shots: []
  },
  characters: [],
  scenes: [],
  generatedVideos: [],
  activeEditorId: null,
  // 弹窗临时数据
  _charModalImage: null,
  _sceneModalImage1: null,
  _sceneModalImage2: null,
  // 机位图确认弹窗
  _spaceModalResolve: null,
  _spaceModalData: null
};

// ============ Agent 对话状态 ============
const AgentState = {
  messages: [],
  totalTokens: 0
};

// ============ 工作流状态 ============
const WorkflowState = {
  step1Done: false,
  step2Done: false,
  step3Done: false,
  step4Done: false,
  shots: [],
  prompts: [],
  reviews: null
};

// ============ 初始化 ============
document.addEventListener('DOMContentLoaded', () => {
  initTagButtons();
  initScriptInput();
  updateCreditsDisplay();
  addDemoAssets();
  // 加载已保存的 Anthropic API Key
  const savedKey = localStorage.getItem('anthropicApiKey') || '';
  const keyInput = document.getElementById('anthropicApiKey');
  if (keyInput && savedKey) keyInput.value = savedKey;
  // 初始化拖放
  initDragDrop();
  // 首页：隐藏所有页，只显示 home
  document.querySelectorAll('.page-section').forEach(s => s.classList.add('hidden'));
  const homePage = document.getElementById('page-home');
  if (homePage) homePage.classList.remove('hidden');
  initHomePage();
});

// ============ 全局拖放（阻止浏览器默认下载行为） ============
function initDragDrop() {
  // 阻止浏览器默认：拖文件进来会触发下载/跳转
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    // 只处理拖到 drop zone 或 textarea 上的情况
    const zone = document.getElementById('scriptDropZone');
    if (zone && zone.contains(e.target)) {
      handleDroppedFiles(e.dataTransfer.files);
    }
  });

  const dropHint = document.getElementById('scriptDropHint');
  if (!dropHint) return;

  // 拖入时高亮
  dropHint.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dropHint.classList.add('drop-zone-active');
  });
  dropHint.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropHint.classList.add('drop-zone-active');
  });
  dropHint.addEventListener('dragleave', () => {
    dropHint.classList.remove('drop-zone-active');
  });
  dropHint.addEventListener('drop', (e) => {
    e.preventDefault();
    dropHint.classList.remove('drop-zone-active');
    handleDroppedFiles(e.dataTransfer.files);
  });
}

function handleDroppedFiles(files) {
  if (!files || files.length === 0) return;
  const file = files[0];
  const allowed = ['.docx', '.txt', '.md', '.fountain'];
  const ext = '.' + file.name.split('.').pop().toLowerCase();
  if (!allowed.includes(ext)) {
    showToast(`不支持的格式：${ext}，请上传 .docx 或 .txt 文件`, 'error');
    return;
  }
  // 复用现有上传逻辑
  handleFileFromObject(file);
}

async function handleFileFromObject(file) {
  const isDocx = file.name.toLowerCase().endsWith('.docx');
  if (isDocx) {
    showToast('正在解析 Word 文档...', 'success');
    try {
      const formData = new FormData();
      formData.append('file', file);
      const resp = await fetch(apiPath('/parse-docx'), { method: 'POST', body: formData });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json.error || '解析失败');
      fillScriptTextarea(json.text, file.name);
      if (json.savedPath) showToast(`✓ 已保存到 ${json.savedPath}`, 'success');
    } catch (e) {
      showToast('Word 解析失败：' + e.message, 'error');
    }
  } else {
    const reader = new FileReader();
    reader.onload = (e) => fillScriptTextarea(e.target.result, file.name);
    reader.readAsText(file, 'utf-8');
  }
}

// ============ 页面导航 ============
function navigateTo(pageId) {
  // 隐藏所有页面
  document.querySelectorAll('.page-section').forEach(s => {
    s.classList.add('hidden');
  });

  // 显示目标页面
  const target = document.getElementById('page-' + pageId);
  if (target) {
    target.classList.remove('hidden');
    // 重新触发动画
    target.style.animation = 'none';
    target.offsetHeight; // reflow
    target.style.animation = '';
  }

  // 更新导航高亮
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.page === pageId);
  });

  AppState.previousPage = AppState.currentPage;
  AppState.currentPage = pageId;

  if (pageId === 'home' || pageId === 'project-detail') {
    initHomePage();
  }

  if (pageId === 'assets') {
    renderAssetsPage();
  }

  // 切换到分镜制作页，更新侧边栏和全局框
  if (pageId === 'shot-production') {
    renderSidebarAssets();
    renderGlobalBox();
    if (AppState.analysis.shots.length > 0 && document.getElementById('shotCards').children.length === 0) {
      renderShotCards();
    }
  }

  // 进入空间报告页，若无数据给提示
  if (pageId === 'space-report') {
    const body = document.getElementById('spaceReportBody');
    if (body && !body.innerHTML.trim()) {
      body.innerHTML = `<div class="text-center py-20 text-gray-500"><p class="text-base">尚未生成空间理解报告</p><p class="text-xs mt-2">请先在「新建项目」流程中触发"AI 工作流"，AI 会先分析场景空间</p></div>`;
    }
  }

  // 如果切换到分集视频页，更新视频列表
  if (pageId === 'episodes') {
    renderEpisodes();
  }
}

function showExtraNavItems() {
  document.querySelectorAll('.nav-btn[data-page="script-analysis"], .nav-btn[data-page="assets"], .nav-btn[data-page="space-report"], .nav-btn[data-page="shot-production"], .nav-btn[data-page="episodes"]').forEach(btn => {
    btn.classList.remove('hidden');
  });
}

// ============ 标签按钮交互 ============
function initTagButtons() {
  ['videoStyleGroup', 'shotStyleGroup'].forEach(groupId => {
    const group = document.getElementById(groupId);
    if (!group) return;
    group.addEventListener('click', (e) => {
      const btn = e.target.closest('.tag-btn');
      if (!btn) return;

      // 单选模式
      group.querySelectorAll('.tag-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      if (groupId === 'videoStyleGroup') AppState.videoStyle = btn.dataset.value;
      if (groupId === 'shotStyleGroup') AppState.shotStyle = btn.dataset.value;
    });
  });
}

// ============ 剧本输入框 ============
function initScriptInput() {
  const textarea = document.getElementById('scriptInput');
  if (!textarea) return;

  textarea.addEventListener('input', () => {
    const text = textarea.value;
    const len = text.length;
    AppState.scriptText = text;

    document.getElementById('charCount').textContent = len.toLocaleString();
    // 首次分析：5积分/100字符
    const cost = Math.ceil(len / 100) * 5;
    document.getElementById('estimatedCredits').textContent = cost.toLocaleString();
    // 同步到分析按钮上的积分显示
    const btnCost = document.getElementById('analyzeBtnCost');
    if (btnCost) btnCost.textContent = cost.toLocaleString() + ' 积分';
  });
}

// ============ 剧本分析 ============
function handleAnalyzeScript() {
  const script = AppState.scriptText || document.getElementById('scriptInput').value;
  if (!script.trim()) {
    showToast('请先输入剧本内容', 'warning');
    return;
  }

  if (!AppState.isLoggedIn) {
    openLoginModal();
    return;
  }

  const apiKey = getApiKey();
  // 方案A使用服务器端Deepseek key，无需前端key
  if (AppState.plan !== 'A' && !apiKey) {
    showModal({
      title: '需要 Anthropic API Key',
      message: '请先前往「设置」页面填写 Anthropic API Key，才能使用方案B AI工作流。\n\n或切换到「方案A：平台代付」使用已接入的 DeepSeek。',
      confirmText: '前往设置',
      onConfirm: () => navigateTo('settings')
    });
    return;
  }

  const charLen = script.length;
  const cost = Math.ceil(charLen / 100) * 5;

  showModal({
    title: '确认 AI 编剧分析',
    message: `剧本字符数：${charLen.toLocaleString()}\n预估消耗积分：${cost.toLocaleString()}\n\nAI 编剧将深度分析剧本结构、人物小传并拆分镜头列表。`,
    confirmText: '确认',
    onConfirm: async () => {
      if (AppState.credits < cost) {
        showToast('积分不足，请充值', 'error');
        return;
      }
      deductCredits(cost);
      showFullscreenLoading('编剧 Agent 正在深度解析剧本结构、人物小传与镜头拆分...');

      try {
        const selectedModel = document.getElementById('planA_analysisModel')?.value || 'deepseek';
        const resp = await fetch(apiPath('/analyze-script'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            script,
            videoStyle: AppState.videoStyle,
            shotStyle: AppState.shotStyle,
            projectName: AppState.projectName,
            apiKey,
            plan: AppState.plan,
            model: selectedModel
          })
        });

        const json = await resp.json();
        if (!resp.ok) throw new Error(json.error || '分析失败');

        const result = json.data;
        AppState.analysis = { ...result, originalScript: script };
        AppState.hasAnalysis = true;

        document.getElementById('analysisTitle').value = result.title || '';
        document.getElementById('analysisGenre').value = result.genre || '';
        document.getElementById('analysisVideoStyle').value = AppState.videoStyle;
        document.getElementById('analysisShotStyle').value = AppState.shotStyle;
        document.getElementById('analysisSynopsis').value = result.synopsis || '';
        document.getElementById('analysisStructure').value = result.structureAnalysis || '';
        document.getElementById('analysisCharBios').value = result.characterBios || '';
        document.getElementById('analysisHighlights').value = result.highlights || '';
        document.getElementById('analysisAiAdapt').value = result.aiAdaptNotes || '';
        document.getElementById('analysisOriginal').value = script;

        // 重置工作流状态
        Object.assign(WorkflowState, {
          step1Done: false, step2Done: false, step3Done: false, step4Done: false,
          shots: [], prompts: [], reviews: null
        });

        updateAnalysisSaveCost();
        autoGenerateAssetsFromAnalysis(result);
        hideFullscreenLoading();
        showExtraNavItems();
        navigateTo('script-analysis');
        showToast(`✓ AI 编剧分析完成，已拆分 ${(result.shots || []).length} 个镜头`, 'success');
      } catch (e) {
        hideFullscreenLoading();
        showToast('分析失败：' + e.message, 'error');
      }
    }
  });
}

function updateAnalysisSaveCost() {
  const el = document.getElementById('analysisSaveCost');
  const original = document.getElementById('analysisOriginal');
  if (el && original) {
    const cost = Math.ceil(original.value.length / 100) * 2;
    el.textContent = cost.toLocaleString() + ' 积分';
  }
}

function selectAspectRatio(btn) {
  const group = document.getElementById('aspectRatioGroup');
  group.querySelectorAll('.tag-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  AppState.aspectRatio = btn.dataset.value;
}

function generateMockAnalysis(script) {
  // 从剧本自动提取或生成模拟数据
  const lines = script.split('\n').filter(l => l.trim());
  const title = AppState.projectName || '未命名剧本';

  return {
    title: title,
    genre: AppState.shotStyle + ' / ' + AppState.videoStyle,
    synopsis: `这是一部${AppState.shotStyle}风格的短剧。${script.substring(0, 200)}...故事围绕主人公展开，通过层层递进的叙事，揭示了人性深处的光明与黑暗。`,
    characterBios: '主角：性格坚毅，内心充满矛盾的年轻人。在一次意外事件后，踏上了探寻真相的旅途。\n配角：主角的挚友，外表冷漠实则温暖，在关键时刻给予主角坚定的支持。',
    highlights: '1. 独特的叙事结构：非线性时间线交错呈现\n2. 视觉风格突出：大量运用明暗对比与色彩象征\n3. 情感张力：通过细腻的人物刻画引发观众共鸣',
    originalScript: script,
    shots: generateMockShots(script)
  };
}

function generateMockShots(script) {
  const lines = script.split('\n').filter(l => l.trim());
  const shotCount = Math.max(3, Math.min(8, Math.ceil(lines.length / 3)));
  const shots = [];

  for (let i = 0; i < shotCount; i++) {
    const lineIndex = Math.floor(i * lines.length / shotCount);
    const actionLine = lines[lineIndex] || `镜头${i + 1}的动作描述`;

    shots.push({
      shotNumber: i + 1,
      action_desc: `【镜头${i + 1}】${actionLine.substring(0, 80)}。运镜缓慢推进，人物情绪由平静转为紧张，光影变化明显。`,
      audio_desc: `环境音：${i % 2 === 0 ? '城市夜晚的远处车流声' : '室内安静的时钟滴答声'}，角色台词同步发声。`
    });
  }
  return shots;
}

// ============ 保存分析修改 ============
function handleSaveAnalysis() {
  const originalText = document.getElementById('analysisOriginal').value;
  const cost = Math.ceil(originalText.length / 100) * 2;

  showModal({
    title: '确认保存修改',
    message: `剧本原文字符数：${originalText.length.toLocaleString()}\n预估消耗积分：${cost.toLocaleString()}`,
    confirmText: '确认保存',
    onConfirm: () => {
      if (AppState.credits < cost) {
        showToast('积分不足，请充值', 'error');
        return;
      }
      deductCredits(cost);

      AppState.analysis.title = document.getElementById('analysisTitle').value;
      AppState.analysis.genre = document.getElementById('analysisGenre').value;
      AppState.analysis.synopsis = document.getElementById('analysisSynopsis').value;
      AppState.analysis.characterBios = document.getElementById('analysisCharBios').value;
      AppState.analysis.highlights = document.getElementById('analysisHighlights').value;
      AppState.analysis.originalScript = originalText;

      showToast('修改已保存', 'success');
    }
  });
}

// ============ 分镜卡片渲染 ============
const GROUP_NAMES = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十'];
const SEGMENT_DURATION_SEC = 15;

function parseDuration(d) {
  if (!d) return 3;
  const m = String(d).match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : 3;
}

function normalizeSeedanceDuration(seconds) {
  const value = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : 3;
  return value <= 5 ? 5 : 10;
}

function groupShotsBy15s(shots) {
  const segments = [];
  let cur = { shots: [], duration: 0 };
  shots.forEach((shot, idx) => {
    const d = parseDuration(shot.duration);
    if (cur.shots.length > 0 && cur.duration + d > SEGMENT_DURATION_SEC) {
      segments.push(cur);
      cur = { shots: [], duration: 0 };
    }
    cur.shots.push({ shot, idx });
    cur.duration += d;
  });
  if (cur.shots.length > 0) segments.push(cur);
  return segments;
}

function renderShotCards() {
  const container = document.getElementById('shotCards');
  if (!container) return;
  container.innerHTML = '';
  const shots = AppState.analysis.shots;
  if (!shots || shots.length === 0) return;

  // 单页扁平列表（Claude 对话流风格），不再按 15 秒分段包裹
  container.className = 'space-y-6';
  shots.forEach((shot, idx) => {
    container.appendChild(createShotCard(shot, idx));
  });
}

// 渲染页面顶部的全局规则框（系统消息风格，全集共享）
function renderGlobalBox() {
  const box = document.getElementById('globalPromptBox');
  if (!box) return;
  const text = buildGlobalBlock();
  box.innerHTML = `
    <div class="flex gap-3 mb-6">
      <div class="w-8 h-8 rounded-full bg-emerald-900/40 border border-emerald-700/40 flex items-center justify-center shrink-0">
        <svg class="w-4 h-4 text-emerald-400" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/>
        </svg>
      </div>
      <div class="flex-1 min-w-0">
        <div class="flex items-center justify-between mb-1.5">
          <span class="text-xs font-medium text-emerald-400 flex items-center gap-1.5">
            全局规则
            <span class="text-[10px] text-gray-600 font-normal">· 出片时自动拼接到每个镜头前，可直接编辑</span>
          </span>
          <button class="text-[11px] text-gray-600 hover:text-gray-400 transition-colors" onclick="toggleGlobalBox()">
            <span id="globalBoxToggleText">收起</span>
          </button>
        </div>
        <div id="globalBoxPanel">
          <pre id="globalBoxEditor"
            contenteditable="true"
            spellcheck="false"
            oninput="AppState.globalPromptOverride = this.innerText"
            class="text-[11px] text-gray-400 whitespace-pre-wrap leading-relaxed font-mono bg-emerald-950/20 border border-emerald-700/20 rounded-xl p-3 focus:outline-none focus:border-emerald-500/40"
          >${escapeHtml(text)}</pre>
        </div>
      </div>
    </div>`;
}

function toggleGlobalBox() {
  const panel = document.getElementById('globalBoxPanel');
  const label = document.getElementById('globalBoxToggleText');
  if (!panel) return;
  const hidden = panel.classList.toggle('hidden');
  if (label) label.textContent = hidden ? '展开' : '收起';
}

function toggleSegmentGlobal(segIndex) {
  const panel = document.getElementById(`seg-global-panel-${segIndex}`);
  const arrow = document.getElementById(`seg-global-arrow-${segIndex}`);
  if (!panel) return;
  const hidden = panel.classList.toggle('hidden');
  if (arrow) arrow.style.transform = hidden ? '' : 'rotate(180deg)';
}

function onSegmentGlobalEdit(el) {
  AppState.globalPromptOverride = el.innerText;
  // 同步到所有段的全局编辑器（保持各段一致）
  document.querySelectorAll('[id^="seg-global-editor-"]').forEach(other => {
    if (other !== el && other.innerText !== el.innerText) other.textContent = el.innerText;
  });
}

const GLOBAL_RULES = `【全局强制规则】
全程画面无任何文字、字幕、水印、乱码；台词仅音频发声，禁止画面显示任何文字；仅保留单镜标注的动作、台词及环境音效，全程无BGM、无冗余音效。
【最高优先级】全程纯真人实拍质感，无 CG / 卡通 / 贴图感，4K 胶片质感，浅景深柔和暗角；自然写实布光，光影随人物 / 场景自然投射；皮肤有真实毛孔肌理，肢体比例贴合人体工学，表情动作自然符合物理逻辑，人物表演与肢体动作高度拟真、自然流畅，如同真人实拍，表情细腻、体态真实、步态自然；衣物道具材质真实，无悬浮穿模；全片无脑补新增元素，人物场景融合无割裂；
【否定】无 CG 感，无磨皮失真，无肢体畸形，无浮空动作，无穿模，无特效光，无五官变形，无僵硬。`;

// 全局规则文本（可被用户覆写）
function buildGlobalBlock() {
  return AppState.globalPromptOverride || GLOBAL_RULES;
}

// 参考图标注块（从 shot 上下文推断角色 + 场景）
function buildRefBlock(shot) {
  const angleStr = shot.subjectAngle || shot.peopleAngle || '';
  const mentioned = AppState.characters.filter(c => angleStr.includes(c.name));
  const chars = mentioned.length > 0 ? mentioned : AppState.characters.slice(0, 3);
  const sceneName = shot.sceneRef || shot.scene || (AppState.scenes[0]?.name) || '<场景名>';
  const charLines = chars.map(c => `@[角色图]：${c.name}，`).join('\n');
  return `# 参考图标注\n${charLines}\n@[场景图]：${sceneName}正面，\n@[场景图]：${sceneName}反打；`;
}

// 按景别推导焦段/光圈智能默认值
function defaultFocalAperture(framing) {
  const f = (framing || '').trim();
  if (/全景|远景/.test(f))   return { focal: '24mm',  ap: 'f/5.6' };
  if (/大特写/.test(f))       return { focal: '100mm', ap: 'f/1.8' };
  if (/特写/.test(f))         return { focal: '85mm',  ap: 'f/2' };
  if (/近景/.test(f))         return { focal: '50mm',  ap: 'f/2.8' };
  return { focal: '35mm', ap: 'f/4' }; // 默认中景
}

// 单镜头提示词块（不含全局规则，全局由 buildGlobalBlock 提供，每段共享）
function buildPromptTemplate(shot) {
  const duration = (() => {
    const raw = shot.duration || '3秒';
    if (/秒/.test(raw)) return raw;
    const m = String(raw).match(/(\d+(?:\.\d+)?)/);
    return m ? `${m[1]}秒` : '3秒';
  })();
  const sceneName = shot.sceneRef || shot.scene || (AppState.scenes[0]?.name) || '<场景名>';
  const shootingFace = shot.shootingFace || shot.shootFace || `${sceneName}正面`;
  const framing      = (shot.framing || '中景').replace(/[\/／].*$/, '').trim() || '中景';
  const verticalAngle = (shot.verticalAngle || shot.perspective || '平视').replace(/[\/／].*$/, '').trim() || '平视';

  // 焦段/光圈：缺省按景别派生
  const fa = defaultFocalAperture(framing);
  const focalLength  = shot.focalLength  || shot.focal_length || fa.focal;
  const aperture     = shot.aperture || fa.ap;

  // 主体角度：缺省取首个角色名 + 正面
  const c0 = AppState.characters[0]?.name;
  const c1 = AppState.characters[1]?.name;
  const c2 = AppState.characters[2]?.name;
  const subjectAngle = shot.subjectAngle || shot.peopleAngle
    || (c0 ? `${c0}正面${c1 ? '，' + c1 + '左侧45°' : ''}` : '<角色名+角度>');

  // 运镜字段：必须包含 前/中/后景 + 画左/中/右 + 群演层 + 情绪 + 台词 + 内心OS
  const action = shot.action_desc
    || `手持跟拍，前景画左为${c0 || '主角'}<动作>，中景画中为${c1 || '配角'}<动作>，后景画右为${c2 || '远景人物'}<动作>，他们身后是与本场题材一致的背景人群或场景氛围元素，情绪<情绪>，台词：「」（仅音频发声，画面不显示文字），内心OS：「」（不开口）`;
  const audio = shot.audio || shot.audio_desc || '全程仅有音频，无BGM';

  return `# 分镜
镜号：${shot.shotNumber};
时长：${duration};
拍摄面：${shootingFace};
焦段：${focalLength};
光圈：${aperture};
主体角度：${subjectAngle};
景别：${framing};
高低：${verticalAngle};
运镜 / 人物调度/ 动作 / 情绪 / 台词 / 内心OS：${action};
音频：${audio};`;
}

// 编辑器只显示单镜头块。若 shot.fullPrompt 是 AI 返回的完整版（含全局），抽取 # 分镜 段。
// 若 fullPrompt 用的是旧格式（缺少 拍摄面/焦段/光圈/主体角度 任一项），自动回退到新模板。
function extractShotBlock(shot) {
  if (shot.fullPrompt && shot.fullPrompt.includes('# 分镜')) {
    const block = shot.fullPrompt.split(/(?=# 分镜)/).pop();
    const isNewFormat = /拍摄面：/.test(block) && /焦段：/.test(block)
      && /光圈：/.test(block) && /主体角度：/.test(block);
    if (isNewFormat) return block;
    // 旧格式：丢弃，按新模板重建
  }
  return buildPromptTemplate(shot);
}

// 用 shotNumber（字符串或数字）查 AppState.analysis.shots 索引
function findShotIndex(shotNumber) {
  const shots = AppState.analysis.shots || [];
  // 1) 字符串完全匹配
  const strMatch = shots.findIndex(s => String(s.shotNumber) === String(shotNumber));
  if (strMatch !== -1) return strMatch;
  // 2) 数字 → idx-1
  if (typeof shotNumber === 'number') return shotNumber - 1;
  // 3) 末段数字 → 不可靠，仅当只有一段时使用
  return -1;
}

// 出片时拼接 = 全局块 + 参考图标注块 + 单镜头块（供出片/复制使用）
function buildFullPromptForShot(shot) {
  const single = (shot.fullPrompt && shot.fullPrompt.includes('# 分镜'))
    ? shot.fullPrompt.split(/(?=# 分镜)/).pop()
    : buildPromptTemplate(shot);
  return `${buildGlobalBlock()}\n\n${buildRefBlock(shot)}\n\n${single}`;
}

// 复制单镜完整提示词到剪贴板
function copyPrompt(index) {
  const shot = AppState.analysis.shots[index];
  if (!shot) return;
  const text = buildFullPromptForShot(shot);
  navigator.clipboard.writeText(text).then(() => {
    showToast('✓ 提示词已复制', 'success');
  }).catch(() => {
    showToast('复制失败，请手动选中文字', 'error');
  });
}

function makeRow(index, key, label, value, multiline = false, placeholder = '') {
  return `<div class="flex items-start border-b border-slate-800/20 last:border-0">
    <span class="w-20 text-xs text-gray-500 shrink-0 px-3 py-2 leading-[1.7] select-none">${label}</span>
    <div contenteditable="true" id="field-${index}-${key}"
      class="flex-1 text-sm text-white px-3 py-2 outline-none focus:bg-slate-800/30 transition-colors${multiline ? ' min-h-[52px]' : ''}"
      oninput="updateShotField(${index},'${key}',this.textContent)"
      onfocus="AppState.activeEditorId='field-${index}-${key}'"
      data-placeholder="${placeholder}"
    >${escapeHtml(value)}</div>
  </div>`;
}

function createShotCard(shot, index) {
  const card = document.createElement('div');
  card.className = 'shot-bubble group';
  card.id = `shot-card-${index}`;

  const refBlock   = buildRefBlock(shot);
  const shotBlock  = extractShotBlock(shot);
  const displayText = refBlock + '\n\n' + shotBlock;
  const subMeta = [shot.duration || '3秒', shot.shootingFace || shot.shootFace || (shot.sceneRef ? shot.sceneRef + '正面' : '')].filter(Boolean).join(' · ');

  card.innerHTML = `
    <div class="flex items-start gap-3">
      <!-- 导演头像 -->
      <div class="w-8 h-8 rounded-full bg-slate-800 border border-slate-700/60 flex items-center justify-center shrink-0 mt-0.5">
        <svg class="w-4 h-4 text-gold-500" fill="currentColor" viewBox="0 0 24 24"><path d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>
      </div>
      <!-- 气泡主体 -->
      <div class="flex-1 min-w-0">
        <div class="flex items-center justify-between mb-1.5">
          <div class="flex items-center gap-2">
            <span class="text-gold-500 font-bold text-sm font-display">分镜 ${shot.shotNumber}</span>
            <span class="text-[10px] text-gray-500">${subMeta}</span>
            <span class="text-[10px] text-emerald-500 prompt-ready-badge hidden">✓ 已就绪</span>
          </div>
          <div class="flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
            <button class="text-[11px] text-gray-500 hover:text-gray-200 px-2 py-0.5 rounded bg-slate-800/60 hover:bg-slate-700/60 transition-colors" onclick="copyPrompt(${index})">复制</button>
            <button class="btn-primary text-xs py-1 px-3" id="generate-btn-${index}" onclick="handleGenerateVideo(${index})">造梦</button>
          </div>
        </div>
        <pre id="editor-${index}"
          contenteditable="true"
          spellcheck="false"
          oninput="onPromptEdit(${index}, this)"
          class="text-[11px] text-gray-300 whitespace-pre-wrap leading-relaxed font-mono bg-slate-900/50 border border-slate-700/30 rounded-xl p-3 select-text cursor-text focus:outline-none focus:border-gold-500/40 custom-scrollbar"
          style="user-select:text;-webkit-user-select:text;"
        >${escapeHtml(displayText)}</pre>
      </div>
    </div>
    <div id="shot-progress-${index}" class="hidden pl-11 mt-2 pb-1">
      <div class="generation-progress"><div class="bar" style="width:0%"></div></div>
      <p class="text-xs text-gray-500 mt-1">AI 正在生成视频...</p>
    </div>
    <div id="shot-result-${index}" class="flex items-center gap-2 pl-11 pb-1"></div>
  `;
  return card;
}

function toggleGlobalRules(index) {
  const panel = document.getElementById(`global-rules-${index}`);
  const arrow = document.getElementById(`rules-arrow-${index}`);
  if (!panel) return;
  const hidden = panel.classList.toggle('hidden');
  if (arrow) arrow.style.transform = hidden ? '' : 'rotate(180deg)';
}

function updateShotField(index, key, value) {
  if (AppState.analysis.shots[index]) {
    AppState.analysis.shots[index][key] = value;
  }
}

// updateShotCardPrompt 统一版本（在 main.js 底部 1606 行处定义）

function updateShotCardFields(index, shot) {
  const framingVal = shot.framing || [shot.perspective, shot.angle].filter(Boolean).join('/') || '';
  const map = {
    action_desc:   shot.action_desc,
    framing:       framingVal,
    focalLength:   shot.focal_length || shot.focalLength,
    aperture:      shot.aperture,
    subjectAngle:  shot.subjectAngle || shot.angle,
    verticalAngle: shot.verticalAngle || shot.perspective,
    shootFace:     shot.shootFace,
    duration:      shot.duration,
    audio:         shot.audio || shot.audio_desc,
  };
  Object.entries(map).forEach(([key, val]) => {
    if (!val) return;
    const el = document.getElementById(`field-${index}-${key}`);
    if (el) el.textContent = val;
  });
}

function selectResolution(btn, index) {
  const parent = btn.parentElement;
  parent.querySelectorAll('.resolution-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');

  const res = btn.dataset.res;
  const costPerSec = getVideoCostPerSecond(res);
  const totalCost = 600 + costPerSec * getShotDurationSeconds(index);
  const costEl = document.getElementById(`shot-cost-${index}`);
  if (costEl) costEl.textContent = totalCost.toLocaleString();
}

function updateEditorCharCount(index) {
  const editor = document.getElementById(`editor-${index}`);
  const len = getPlainTextLength(editor.innerText);
  const countEl = document.getElementById(`shot-charcount-${index}`);
  const isOver = len > 2000;

  countEl.innerHTML = `
    <span class="text-gray-500">字数：</span>
    <span class="${isOver ? 'text-red-400' : 'text-gold-400'}">${len}</span>
    <span class="text-gray-600"> / 2000</span>
  `;

  // 按钮置灰
  const btn = document.getElementById(`generate-btn-${index}`);
  if (btn) btn.disabled = isOver;
}

function getPlainTextLength(text) {
  return text.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().length;
}

// ============ 视频生成 ============
function getShotVideoPrompt(index) {
  const editor = document.getElementById(`editor-${index}`);
  const edited = editor?.innerText?.trim();
  if (edited) return edited;
  const shot = AppState.analysis?.shots?.[index] || {};
  return (shot.fullPrompt || shot.prompt || shot.singlePrompt || shot.description || '').trim();
}

function getShotRequestedDurationSeconds(index) {
  const shot = AppState.analysis?.shots?.[index] || {};
  const editorText = document.getElementById(`editor-${index}`)?.innerText || '';
  const promptText = [
    editorText,
    shot.fullPrompt,
    shot.prompt,
    shot.singlePrompt,
    shot.description
  ].filter(Boolean).join('\n');
  const promptDuration = promptText.match(/时长[：:]\s*(\d+(?:\.\d+)?)\s*秒/);
  const sourceDuration = shot.duration || (promptDuration ? `${promptDuration[1]}秒` : '3秒');
  return parseDuration(sourceDuration);
}

function getShotDurationSeconds(index) {
  return normalizeSeedanceDuration(getShotRequestedDurationSeconds(index));
}

function updateShotGenerateButton(index, text, loading = false) {
  const btn = document.getElementById(`generate-btn-${index}`);
  if (!btn) return;
  btn.disabled = loading;
  btn.innerHTML = loading
    ? `<svg class="w-4 h-4 animate-spin" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg> ${text}`
    : `<svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"/><path d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg> ${text}`;
}

function setShotProgress(index, percent) {
  const progressEl = document.getElementById(`shot-progress-${index}`);
  if (!progressEl) return;
  progressEl.classList.remove('hidden');
  const bar = progressEl.querySelector('.bar');
  if (bar) bar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
}

function hideShotProgress(index) {
  const progressEl = document.getElementById(`shot-progress-${index}`);
  if (progressEl) progressEl.classList.add('hidden');
}

function getVideoCostPerSecond(resolution) {
  return String(resolution) === '1080' ? 210 : 105;
}

async function pollVideoTask(taskId, index) {
  const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
  const maxAttempts = 90;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await wait(attempt === 1 ? 3000 : 10000);
    setShotProgress(index, Math.min(92, 12 + attempt * 4));

    const resp = await fetch(apiPath(`/video-task/${encodeURIComponent(taskId)}`));
    const json = await resp.json();
    if (!resp.ok || !json.success) throw new Error(json.error || '查询视频任务失败');

    const task = json.task || {};
    const status = task.status || task.task_status || '';
    if (status === 'succeeded') return task;
    if (status === 'failed' || status === 'cancelled') {
      const detail = task.error || task.message || 'Seedance 任务失败';
      throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
    }
  }

  throw new Error('Seedance 任务仍在生成中，请稍后重试查询');
}

function handleGenerateVideo(index) {
  const resBtn = document.querySelector(`#shot-card-${index} .resolution-btn.active`);
  const res = resBtn ? resBtn.dataset.res : '480';
  const costPerSec = getVideoCostPerSecond(res);
  const requestedDuration = getShotRequestedDurationSeconds(index);
  const duration = getShotDurationSeconds(index);
  const totalCost = 600 + costPerSec * duration;
  const prompt = getShotVideoPrompt(index);

  if (!prompt) {
    showToast('请先生成或填写 Seedance 提示词', 'error');
    return;
  }

  showModal({
    title: '确认开始造梦',
    message: `镜头 #${index + 1}\n分辨率：${res}P\n分镜时长：${requestedDuration} 秒\nSeedance实际生成：${duration} 秒\n基础算力：600 积分\n视频生成：${(costPerSec * duration).toLocaleString()} 积分\n总消耗：${totalCost.toLocaleString()} 积分`,
    confirmText: '开始造梦',
    onConfirm: async () => {
      if (AppState.credits < totalCost) {
        showToast('积分不足，请充值', 'error');
        return;
      }

      deductCredits(totalCost);
      setShotProgress(index, 6);
      updateShotGenerateButton(index, '创建任务...', true);

      try {
        const createResp = await fetch(apiPath('/generate-video'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt,
            shotNumber: index + 1,
            ratio: AppState.aspectRatio || '9:16',
            duration,
            resolution: res,
            generateAudio: true,
            watermark: false
          })
        });
        const created = await createResp.json();
        if (!createResp.ok || !created.success) throw new Error(created.error || '创建视频任务失败');

        setShotProgress(index, 15);
        updateShotGenerateButton(index, '生成中...', true);
        const task = await pollVideoTask(created.taskId, index);

        setShotProgress(index, 96);
        updateShotGenerateButton(index, '下载中...', true);
        const downloadResp = await fetch(apiPath(`/video-task/${encodeURIComponent(created.taskId)}/download`), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ shotNumber: index + 1 })
        });
        const downloaded = await downloadResp.json();
        if (!downloadResp.ok || !downloaded.success) throw new Error(downloaded.error || '下载视频失败');

        setShotProgress(index, 100);
        hideShotProgress(index);
        updateShotGenerateButton(index, '重新生成', false);

        const resultEl = document.getElementById(`shot-result-${index}`);
        resultEl.innerHTML = `
          <span class="text-xs text-green-400 flex items-center gap-1">
            <svg class="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>
            已生成
          </span>
          <button class="btn-secondary text-xs py-1 px-3" onclick="downloadVideo(${index})">下载</button>
          <button class="btn-danger text-xs py-1 px-3" onclick="deleteVideo(${index})">删除</button>
        `;

        AppState.generatedVideos = AppState.generatedVideos.filter(v => v.shotNumber !== index + 1);
        AppState.generatedVideos.push({
          shotNumber: index + 1,
          resolution: res + 'P',
          duration: `${duration}s`,
          timestamp: new Date().toLocaleString(),
          taskId: created.taskId,
          url: downloaded.url,
          remoteVideoUrl: task.content?.video_url || ''
        });

        showToast(`镜头 #${index + 1} 视频生成完成`, 'success');
      } catch (e) {
        hideShotProgress(index);
        updateShotGenerateButton(index, '重新生成', false);
        showToast(e.message || '视频生成失败', 'error');
      }
    }
  });
}

function downloadVideo(index) {
  const video = AppState.generatedVideos.find(v => v.shotNumber === index + 1);
  if (!video?.url) {
    showToast('还没有可下载的视频文件', 'error');
    return;
  }
  const a = document.createElement('a');
  a.href = video.url;
  a.download = `shot-${index + 1}.mp4`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function deleteVideo(index) {
  showModal({
    title: '确认删除',
    message: `确定要删除镜头 #${index + 1} 的生成视频吗？此操作不可撤销。`,
    confirmText: '确认删除',
    isDanger: true,
    onConfirm: () => {
      const resultEl = document.getElementById(`shot-result-${index}`);
      resultEl.innerHTML = '';
      const btn = document.getElementById(`generate-btn-${index}`);
      btn.innerHTML = `<svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"/><path d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg> 开始造梦`;

      AppState.generatedVideos = AppState.generatedVideos.filter(v => v.shotNumber !== index + 1);
      showToast('视频已删除', 'success');
    }
  });
}

// ============ 添加新镜头 ============
function addNewShot() {
  const nextNum = AppState.analysis.shots.length + 1;
  // 推导段号：按 15 秒累计估算
  const totalDur = (AppState.analysis.shots || []).reduce((sum, s) => sum + parseDuration(s.duration), 0);
  const segIndex = Math.floor(totalDur / SEGMENT_DURATION_SEC) + 1;
  const seqInSeg = AppState.analysis.shots.filter((s) => {
    const num = String(s.shotNumber || '');
    return num.startsWith(`-${segIndex}-`) || num.includes(`-${segIndex}-`);
  }).length + 1;

  const epPrefix = (AppState.analysis.episodeNumber || '16');
  const defaultScene = AppState.scenes[0]?.name || '';
  const fa = defaultFocalAperture('中景');
  const c0 = AppState.characters[0]?.name || '主角';
  const c1 = AppState.characters[1]?.name || '配角';
  const c2 = AppState.characters[2]?.name || '远景人物';
  const newShot = {
    shotNumber: `${epPrefix}-${segIndex}-${seqInSeg}`,
    duration: '3秒',
    sceneRef: defaultScene,
    shootingFace: defaultScene ? `${defaultScene}正面` : '',
    focalLength: fa.focal,
    aperture: fa.ap,
    subjectAngle: `${c0}正面`,
    framing: '中景',
    verticalAngle: '平视',
    action_desc: `手持跟拍，前景画左为${c0}<动作>，中景画中为${c1}<动作>，后景画右为${c2}<动作>，他们身后是与本场题材一致的背景人群或场景氛围元素，情绪<情绪>，台词：「」（仅音频发声，画面不显示文字），内心OS：「」（不开口）`,
    audio_desc: '全程仅有音频，无BGM'
  };
  AppState.analysis.shots.push(newShot);

  // 重新渲染整页（因为分段结构会变）
  renderShotCards();

  const card = document.getElementById(`shot-card-${nextNum - 1}`);
  if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  showToast(`镜头 ${newShot.shotNumber} 已添加`, 'success');
}

// ============ 资产管理 ============
function addDemoAssets() {
  AppState.characters = [];
  AppState.scenes = [];
  renderAssetList();
}

function renderAssetList() {
  renderAnalysisPageAssets();
}

function autoGenerateAssetsFromAnalysis(result) {
  const chars = [];
  if (result.characterBios) {
    // 把 "1. 名字：描述2. 名字：描述" 这种单行编号格式转成多行，再统一处理
    const normalized = result.characterBios.replace(/(\d+)\.\s+([^\d\s])/g, '\n$1. $2');
    normalized.split('\n').forEach(line => {
      line = line.trim().replace(/^[•\d\.]+\s*/, '');
      if (!line) return;
      let name = null;
      let m;
      // **name** 或 **name**（...）
      if (!name && (m = line.match(/^\*{1,2}([^*（：:\n]{1,15})\*{1,2}/))) name = m[1].trim();
      // 【name】
      if (!name && (m = line.match(/^【([^】]{1,15})】/))) name = m[1].trim();
      // name（...）： 或 name：
      if (!name && (m = line.match(/^([^\*\[【（：:\n]{1,15})(?:（[^）]*）)?\s*[：:]/))) name = m[1].trim();
      // name - 描述（无冒号）
      if (!name && (m = line.match(/^([^\-\n]{1,15})\s*[-–—]\s+\S/))) name = m[1].trim();
      if (name) name = name.replace(/[\*\s【】\[\]]/g, '').trim();
      if (name && name.length >= 2 && !chars.find(c => c.name === name)) {
        chars.push({ id: Date.now() + chars.length, name, image: null });
      }
    });
  }

  const sceneSet = new Set();
  const scenes = [];
  if (result.shots) {
    result.shots.forEach(shot => {
      if (!shot.scene) return;
      let name = shot.scene
        .replace(/^(INT\/EXT\.|INT\.|EXT\.|内景\.|外景\.)\s*/i, '')
        .replace(/\s*[-–—·]\s*(日|夜|日落|黄昏|清晨|傍晚|午后|正午|深夜|黎明|凌晨).*$/, '')
        .replace(/\s*[-–—]\s*.+$/, '')
        .trim();
      if (name && !sceneSet.has(name)) {
        sceneSet.add(name);
        scenes.push({ id: Date.now() + scenes.length + 1000, name, image: null });
      }
    });
  }

  AppState.characters = chars;
  // 合并新场景，保留已上传图片（同名场景继承 image/imageReverse/spaceAnalysis）
  const existingSceneMap = new Map(AppState.scenes.map(s => [s.name, s]));
  AppState.scenes = scenes.map(s => {
    const old = existingSceneMap.get(s.name);
    return old ? { ...s, image: old.image, imageReverse: old.imageReverse, spaceAnalysis: old.spaceAnalysis } : s;
  });
  renderAnalysisPageAssets();
  renderAssetsPage();
}

function renderAnalysisPageAssets() {
  const section = document.getElementById('analysisAssetsSection');
  if (!section) return;

  if (AppState.characters.length > 0 || AppState.scenes.length > 0) {
    section.classList.remove('hidden');
  }

  const charCount = document.getElementById('analysisCharCount');
  const sceneCount = document.getElementById('analysisSceneCount');
  if (charCount) charCount.textContent = AppState.characters.length ? `（${AppState.characters.length}）` : '';
  if (sceneCount) sceneCount.textContent = AppState.scenes.length ? `（${AppState.scenes.length}）` : '';

  const charList = document.getElementById('analysisCharacterList');
  const sceneList = document.getElementById('analysisSceneList');

  if (charList) {
    charList.innerHTML = AppState.characters.length === 0
      ? '<p class="text-xs text-gray-500">暂无角色数据</p>'
      : AppState.characters.map(c => `
        <div class="flex items-center gap-3 p-2 rounded-lg bg-slate-800/40 border border-slate-700/30 hover:border-gold-500/30 transition-colors group cursor-pointer" onclick="openCharacterModal(${c.id})">
          <div class="w-8 h-8 rounded-lg bg-gradient-to-br from-slate-700 to-slate-800 flex items-center justify-center shrink-0 overflow-hidden">
            ${c.image ? `<img src="${c.image}" class="w-full h-full object-cover"/>` : `<svg class="w-4 h-4 text-gray-500" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/></svg>`}
          </div>
          <span class="text-sm text-white flex-1">${c.name}</span>
          <button class="hidden group-hover:block text-xs text-red-400 hover:text-red-300 transition-colors" onclick="event.stopPropagation();removeCharacter(${c.id})">删除</button>
        </div>`).join('');
  }

  if (sceneList) {
    sceneList.innerHTML = AppState.scenes.length === 0
      ? '<p class="text-xs text-gray-500">暂无场景数据</p>'
      : AppState.scenes.map(s => `
        <div class="flex items-center gap-3 p-2 rounded-lg bg-slate-800/40 border border-slate-700/30 hover:border-gold-500/30 transition-colors group cursor-pointer" onclick="openSceneModal(${s.id})">
          <div class="w-8 h-8 rounded-lg bg-gradient-to-br from-slate-700 to-slate-800 flex items-center justify-center shrink-0 overflow-hidden">
            ${s.image ? `<img src="${s.image}" class="w-full h-full object-cover"/>` : `<svg class="w-4 h-4 text-gray-500" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>`}
          </div>
          <span class="text-sm text-white flex-1">${s.name}</span>
          <button class="hidden group-hover:block text-xs text-red-400 hover:text-red-300 transition-colors" onclick="event.stopPropagation();removeScene(${s.id})">删除</button>
        </div>`).join('');
  }
}

function removeCharacter(id) {
  AppState.characters = AppState.characters.filter(c => c.id !== id);
  renderAnalysisPageAssets();
  renderAssetsPage();
  renderSidebarAssets();
}

function removeScene(id) {
  AppState.scenes = AppState.scenes.filter(s => s.id !== id);
  renderAnalysisPageAssets();
  renderAssetsPage();
  renderSidebarAssets();
}

// ============ 空间理解报告查看弹窗 ============
function showSpaceAnalysis(sceneId) {
  const scene = AppState.scenes.find(s => s.id === sceneId);
  if (!scene || !scene.spaceAnalysis) return;
  const a = scene.spaceAnalysis;

  const facesHtml = (a.shootingFaces || []).map(f => {
    if (typeof f === 'string') return `<div class="py-1.5 border-b border-slate-700/30 text-xs text-gray-300 col-span-4">${escapeHtml(f)}</div>`;
    return `<div class="contents">
      <div class="py-1.5 text-xs text-gold-400 font-semibold border-b border-slate-700/30">${escapeHtml(f.name)}</div>
      <div class="py-1.5 text-xs text-gray-400 border-b border-slate-700/30">${escapeHtml(f.background)}</div>
      <div class="py-1.5 text-xs text-gray-500 border-b border-slate-700/30">${escapeHtml(f.characterFacing || f.usage || '')}</div>
      <div class="py-1.5 text-xs text-emerald-400 border-b border-slate-700/30">${escapeHtml(f.characterInFrame || '')}</div>
    </div>`;
  }).join('');

  showModal({
    title: `${scene.name} · 空间理解报告`,
    message: a.spatialFlow || a.spaceDescription || '',
    confirmText: '关闭',
    onConfirm: () => {}
  });

  setTimeout(() => {
    const content = document.getElementById('modalContent');
    if (!content) return;
    const extra = document.createElement('div');
    extra.className = 'mt-4 space-y-3 text-xs';
    extra.innerHTML = `
      ${a.characterPositions ? `<div class="bg-slate-800/40 rounded-xl p-3"><p class="text-gold-400 mb-2">▌ 角色站位（首帧）</p><pre class="text-[11px] text-gray-300 whitespace-pre-wrap leading-relaxed font-mono">${escapeHtml(a.characterPositions)}</pre></div>` : ''}
      ${a.axisLine ? `<div class="bg-slate-800/40 rounded-lg p-2"><span class="text-gold-400">180度轴线：</span><span class="text-gray-300">${escapeHtml(a.axisLine)}</span></div>` : ''}
      ${facesHtml ? `
      <div class="bg-slate-800/40 rounded-xl p-3">
        <p class="text-gold-400 mb-2">▌ 四个拍摄面</p>
        <div class="grid grid-cols-4 gap-x-3 gap-y-0 text-[10px] text-gray-500 mb-1">
          <span>机位名称</span><span>背景</span><span>人物朝向</span><span style="color:#6ee7b7">角色在画面里的位置</span>
        </div>
        <div class="grid grid-cols-4 gap-x-3">${facesHtml}</div>
      </div>` : ''}
      ${a.directorNotes ? `<div class="text-gold-400/80 bg-gold-500/5 rounded-lg p-2">💡 ${escapeHtml(a.directorNotes)}</div>` : ''}
    `;
    const btn = content.querySelector('.flex.justify-end');
    if (btn) content.insertBefore(extra, btn);
  }, 10);
}

// ============ 独立资产页面渲染 ============
function renderAssetsPage() {
  const charGrid = document.getElementById('assetsCharGrid');
  const sceneGrid = document.getElementById('assetsSceneGrid');
  const charBadge = document.getElementById('assetsCharCountBadge');
  const sceneBadge = document.getElementById('assetsSceneCountBadge');
  if (!charGrid) return;

  if (charBadge) charBadge.textContent = AppState.characters.length ? `（${AppState.characters.length}）` : '';
  if (sceneBadge) sceneBadge.textContent = AppState.scenes.length ? `（${AppState.scenes.length}）` : '';

  charGrid.innerHTML = AppState.characters.length === 0
    ? '<div class="text-xs text-gray-500 col-span-full py-6 text-center">请先完成剧本分析，角色将自动提取</div>'
    : AppState.characters.map(c => `
      <div class="group relative cursor-pointer rounded-xl overflow-hidden border border-slate-700/40 hover:border-gold-500/50 transition-colors bg-slate-800/40 aspect-square flex flex-col items-center justify-center gap-2 p-3"
           onclick="openCharacterModal(${c.id})">
        ${c.image
          ? `<img src="${c.image}" class="w-16 h-16 rounded-lg object-cover"/>`
          : `<div class="w-16 h-16 rounded-lg bg-slate-700 flex items-center justify-center"><svg class="w-7 h-7 text-gray-500" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/></svg></div>`}
        <p class="text-xs text-white text-center truncate w-full">${c.name}</p>
        <button class="absolute top-1 right-1 hidden group-hover:flex w-5 h-5 items-center justify-center rounded-full bg-red-500/80 text-white text-[10px]"
                onclick="event.stopPropagation();removeCharacter(${c.id})">✕</button>
      </div>`).join('');

  sceneGrid.innerHTML = AppState.scenes.length === 0
    ? '<div class="text-xs text-gray-500 col-span-full py-6 text-center">请先完成剧本分析，场景将自动提取</div>'
    : AppState.scenes.map(s => {
      const hasAnalysis = !!s.spaceAnalysis;
      const camCount = s.spaceAnalysis?.shootingFaces?.length || 0;
      return `
      <div class="group relative rounded-xl overflow-hidden border ${hasAnalysis ? 'border-gold-500/40' : 'border-slate-700/40'} hover:border-gold-500/60 transition-colors bg-slate-800/40">
        <div class="relative aspect-video flex flex-col items-center justify-center gap-2 p-3 cursor-pointer" onclick="openSceneModal(${s.id})">
          ${s.image
            ? `<img src="${s.image}" class="w-full h-full object-cover absolute inset-0 rounded-t-xl opacity-60"/>`
            : `<svg class="w-7 h-7 text-gray-500" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>`}
          <p class="relative text-xs text-white text-center truncate w-full font-medium">${s.name}</p>
          ${hasAnalysis ? `<span class="relative text-[10px] text-gold-400 bg-gold-500/10 px-2 py-0.5 rounded-full">📋 ${camCount}个拍摄面</span>` : ''}
          <button class="absolute top-1 right-1 hidden group-hover:flex w-5 h-5 items-center justify-center rounded-full bg-red-500/80 text-white text-[10px]"
                  onclick="event.stopPropagation();removeScene(${s.id})">✕</button>
        </div>
        ${s.image ? `
        <div class="border-t border-slate-700/30 px-2 py-1.5 flex items-center gap-2">
          <button id="analyze-space-btn-${s.id}"
            class="flex-1 flex items-center justify-center gap-1 text-[11px] py-1 rounded-lg transition-colors ${hasAnalysis ? 'text-gold-400 hover:bg-gold-500/10' : 'text-gray-400 hover:bg-slate-700/50'}"
            onclick="analyzeSceneSpace(${s.id})">
            ${hasAnalysis
              ? `<svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg> 重新分析`
              : `🗺️ AI分析空间`}
          </button>
          ${hasAnalysis ? `<button class="text-[11px] text-gray-500 hover:text-gold-400 px-2" onclick="showSpaceAnalysis(${s.id})">查看空间报告</button>` : ''}
        </div>` : ''}
      </div>`;
    }).join('');
}

// ============ 镜头制作入口（从剧本分析页点击） ============
function startShotWorkflow() {
  if (WorkflowState.step2Done) {
    navigateTo('shot-production');
    return;
  }
  navigateTo('ai-loading');
  runBackgroundWorkflow();
}

// ============ AI加载页状态更新 ============
function setLoadingStep(step, status) {
  // step: 2 或 3，status: 'running' | 'done' | 'error'
  const icon = document.getElementById(`loadStep${step}Icon`);
  const label = document.getElementById(`loadStep${step}Label`);
  if (!icon) return;
  if (status === 'running') {
    icon.innerHTML = `<svg class="w-3 h-3 text-gold-400 animate-spin" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>`;
    icon.className = 'w-6 h-6 rounded-full flex items-center justify-center bg-gold-500/10 border border-gold-500/40 shrink-0';
    if (label) label.className = 'text-sm text-gray-200';
  } else if (status === 'done') {
    icon.innerHTML = `<svg class="w-3.5 h-3.5 text-emerald-400" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg>`;
    icon.className = 'w-6 h-6 rounded-full flex items-center justify-center bg-emerald-500/20 border border-emerald-500/50 shrink-0';
    if (label) label.className = 'text-sm text-emerald-400';
  } else if (status === 'error') {
    icon.innerHTML = `<svg class="w-3.5 h-3.5 text-red-400" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M6 18L18 6M6 6l12 12"/></svg>`;
    icon.className = 'w-6 h-6 rounded-full flex items-center justify-center bg-red-500/20 border border-red-500/50 shrink-0';
    if (label) label.className = 'text-sm text-red-400';
  }
}

function setLoadingStatus(msg) {
  const el = document.getElementById('aiLoadingStatus');
  if (el) el.textContent = msg;
}

// ============ 后台工作流（两阶段·简化版） ============
// 阶段一：AI 分析场景空间 → 空间报告确认
// 阶段二：AI导演一步直出分镜+提示词 → 进入分镜制作页

async function runBackgroundWorkflow() {
  try {
    // ── 阶段一：AI 分析场景空间结构（双通道：有图→视觉模型，无图→剧本文字推断）──
    const scenesWithImages = AppState.scenes.filter(s => s.image && !s.spaceAnalysis);
    const scenesWithoutImages = AppState.scenes.filter(s => !s.image && !s.spaceAnalysis);
    const hasAnyScene = AppState.scenes.length > 0;

    if (scenesWithImages.length > 0) {
      setLoadingStatus(`AI 正在分析 ${scenesWithImages.length} 个场景图，生成空间理解报告...`);
      const scriptTextForImg = AppState.analysis.originalScript || AppState.scriptText || '';
      const shotsForImg = AppState.analysis.shots || [];

      const results = await Promise.allSettled(scenesWithImages.map(async (scene) => {
        const shotDescs = shotsForImg
          .filter(s => s.scene && s.scene.includes(scene.name))
          .map(s => s.action_desc).filter(Boolean);
        const resp = await fetch(apiPath('/analyze-scene-space'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ imageBase64: scene.image, sceneName: scene.name, scriptText: scriptTextForImg, shotDescriptions: shotDescs })
        });
        const json = await resp.json();
        if (!resp.ok) throw new Error(json.error || `场景「${scene.name}」分析失败`);
        const idx = AppState.scenes.findIndex(s => s.id === scene.id);
        if (idx !== -1) AppState.scenes[idx].spaceAnalysis = json.data;
        return scene.name;
      }));
      const failed = results.filter(r => r.status === 'rejected');
      if (failed.length) showToast(`⚠️ ${failed.length} 个场景分析失败，可在弹窗中手动补充`, 'warning');
    }

    if (scenesWithoutImages.length > 0) {
      setLoadingStatus(`AI 正在从剧本推断 ${scenesWithoutImages.length} 个场景的空间理解报告...`);
      const scriptText = AppState.analysis.originalScript || AppState.scriptText || '';
      const shots = AppState.analysis.shots || [];

      const results2 = await Promise.allSettled(scenesWithoutImages.map(async (scene) => {
        const shotDescs = shots.filter(s => s.scene && s.scene.includes(scene.name)).map(s => s.action_desc).filter(Boolean);
        const resp = await fetch(apiPath('/analyze-scene-space-from-script'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sceneName: scene.name, scriptText, shotDescriptions: shotDescs })
        });
        const json = await resp.json();
        if (!resp.ok) throw new Error(json.error || `场景「${scene.name}」剧本分析失败`);
        const idx = AppState.scenes.findIndex(s => s.id === scene.id);
        if (idx !== -1) AppState.scenes[idx].spaceAnalysis = json.data;
        return scene.name;
      }));
      const failed2 = results2.filter(r => r.status === 'rejected');
      if (failed2.length) showToast(`⚠️ ${failed2.length} 个场景推断失败，可在弹窗中手动补充`, 'warning');
    }

    let sceneSpaceAnalyses = AppState.scenes
      .filter(s => s.spaceAnalysis)
      .map(s => ({ sceneName: s.name, sceneId: s.id, analysis: s.spaceAnalysis }));

    if (sceneSpaceAnalyses.length > 0 || hasAnyScene) {
      setLoadingStatus('空间理解报告已生成，请在「空间报告」页面确认/调整后继续...');
      if (sceneSpaceAnalyses.length === 0 && hasAnyScene) {
        sceneSpaceAnalyses = AppState.scenes.map(s => ({
          sceneName: s.name, sceneId: s.id,
          analysis: { spaceDescription: '', spatialFlow: '', characterPositions: '', axisLine: '', lightSource: '', shootingFaces: [], directorNotes: '' }
        }));
      }
      sceneSpaceAnalyses = await showSpaceDiagramModal(sceneSpaceAnalyses);
    }

    // ── 阶段二：AI导演一步直出分镜+提示词 ──
    setLoadingStep(2, 'running');
    setLoadingStatus('AI导演正在一步生成分镜提示词...');
    // 更新加载步骤标签
    const lbl2 = document.getElementById('loadStep2Label');
    if (lbl2) lbl2.textContent = 'AI导演正在生成分镜提示词...';
    const lbl3 = document.getElementById('loadStep3Label');
    if (lbl3) lbl3.textContent = '（已合并至上一步）';

    const resp = await fetch(apiPath('/director-prompts'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        analysis: AppState.analysis,
        videoStyle: AppState.videoStyle,
        shotStyle: AppState.shotStyle,
        aspectRatio: AppState.aspectRatio,
        sceneSpaceAnalyses,
        shotRules: AppState.analysis.shotRules,
        styleGuide: AppState.analysis.styleGuide,
        worldview: AppState.analysis.worldview
      })
    });
    const j = await resp.json();
    if (!resp.ok) throw new Error(j.error);

    // 写入 AppState
    const newShots = j.data.shots || [];
    newShots.forEach(s => {
      if (s.singlePrompt) s.fullPrompt = s.singlePrompt;
    });
    AppState.analysis.shots = newShots;
    WorkflowState.shots = newShots;
    WorkflowState.step2Done = true;
    setLoadingStep(2, 'done');
    setLoadingStep(3, 'done');
    setLoadingStatus('全部完成！正在进入分镜制作...');

    renderShotCards();
    setTimeout(() => {
      navigateTo('shot-production');
      const spaceCount = sceneSpaceAnalyses.length;
      const suffix = spaceCount > 0 ? `（${spaceCount} 个场景空间报告已确认）` : '';
      showToast(`✓ 分镜方案就绪，共 ${WorkflowState.shots.length} 个镜头${suffix}`, 'success');
    }, 800);

  } catch (e) {
    console.error('工作流失败:', e.message);
    setLoadingStatus(`⚠️ ${e.message}`);
    setTimeout(() => navigateTo('shot-production'), 2500);
  }
}

// ============ 空间理解报告（独立页面） ============
// 返回 Promise，resolve 值为用户编辑后的 sceneSpaceAnalyses
function showSpaceDiagramModal(sceneSpaceAnalyses) {
  return new Promise((resolve) => {
    AppState._spaceModalResolve = resolve;
    AppState._spaceModalData = JSON.parse(JSON.stringify(sceneSpaceAnalyses)); // 深拷贝

    // 切到独立页面
    showExtraNavItems();
    const navBtn = document.querySelector('.nav-btn[data-page="space-report"]');
    if (navBtn) navBtn.classList.remove('hidden');
    navigateTo('space-report');

    const body = document.getElementById('spaceReportBody');
    if (!body) { resolve(sceneSpaceAnalyses); return; }

    // 渲染每个场景的空间理解报告编辑区
    const FACES_COUNT = 4;
    body.innerHTML = sceneSpaceAnalyses.map((item, i) => {
      const a = item.analysis;
      // normalize shootingFaces to objects，不足4行补空行
      const MARKERS = ['①', '②', '③', '④'];
      const faces = (a.shootingFaces || []).map(f =>
        typeof f === 'string'
          ? { marker: '', name: f, cameraPosition: '', lensDirection: '', background: '', characterFacing: '', characterInFrame: '' }
          : { characterInFrame: '', ...f }
      );
      while (faces.length < FACES_COUNT) faces.push({ marker: '', name: '', cameraPosition: '', lensDirection: '', background: '', characterFacing: '', characterInFrame: '' });
      // 兜底：marker 缺失时用①②③④，老字段 usage→characterFacing
      faces.forEach((f, fi) => {
        if (!f.marker) f.marker = MARKERS[fi] || '';
        if (!f.characterFacing && f.usage) f.characterFacing = f.usage;
      });

      const facesRows = faces.map((f, fi) => `
        <tr class="align-top">
          <td class="pr-2 pb-2 text-center text-gold-400 font-mono text-sm w-[5%] pt-1.5">${escapeHtml(f.marker || MARKERS[fi])}</td>
          <td class="pr-2 pb-2 w-[18%]">
            <textarea id="face-name-${i}-${fi}" rows="2"
              class="w-full bg-slate-900/60 border border-slate-700/40 rounded px-2 py-1 text-xs text-gold-300 focus:outline-none focus:border-gold-500/50 resize-none"
              placeholder="机位名称（如：示例场景正面）">${escapeHtml(f.name || '')}</textarea>
          </td>
          <td class="pr-2 pb-2 w-[22%]">
            <textarea id="face-bg-${i}-${fi}" rows="2"
              class="w-full bg-slate-900/60 border border-slate-700/40 rounded px-2 py-1 text-xs text-gray-300 focus:outline-none focus:border-gold-500/50 resize-none"
              placeholder="背景（如：楼梯铁门、台阶、墙）">${escapeHtml(f.background || '')}</textarea>
          </td>
          <td class="pr-2 pb-2 w-[22%]">
            <textarea id="face-facing-${i}-${fi}" rows="2"
              class="w-full bg-slate-900/60 border border-slate-700/40 rounded px-2 py-1 text-xs text-gray-300 focus:outline-none focus:border-gold-500/50 resize-none"
              placeholder="人物朝向（如：角色A正面；角色B背面）">${escapeHtml(f.characterFacing || '')}</textarea>
          </td>
          <td class="pb-2 w-[33%]">
            <textarea id="face-inframe-${i}-${fi}" rows="2"
              class="w-full bg-slate-900/60 border border-slate-700/40 rounded px-2 py-1 text-xs text-emerald-300 focus:outline-none focus:border-gold-500/50 resize-none"
              placeholder="角色在画面里的位置（如：角色A画左近景；角色B画右中景）">${escapeHtml(f.characterInFrame || '')}</textarea>
          </td>
        </tr>`).join('');

      return `
      <div class="border border-slate-700/50 rounded-xl overflow-hidden mb-4">
        <div class="px-4 py-3 bg-slate-800/60 flex items-center justify-between">
          <h4 class="text-sm font-semibold text-white flex items-center gap-2">
            <span class="w-2 h-2 rounded-full bg-gold-500"></span>
            ${escapeHtml(item.sceneName)}
          </h4>
          <span class="text-xs text-gray-500">可直接编辑</span>
        </div>
        <div class="p-4 space-y-4">

          <div>
            <label class="block text-xs text-gold-400 mb-1">▌ 空间结构（平面图·用A端/B端标注方向）</label>
            <textarea id="space-flow-${i}" rows="2"
              class="w-full bg-slate-900/60 border border-slate-700/40 rounded-lg px-3 py-2 text-xs text-emerald-300 font-mono resize-y focus:outline-none focus:border-gold-500/50"
              placeholder="如：入口区 → 主空间（A端·关键道具）→ 分隔物 → 内部区域（B端·行动区域）→ 出口"
              >${escapeHtml(a.spatialFlow || a.spaceDescription || '')}</textarea>
          </div>

          <div>
            <label class="block text-xs text-gold-400 mb-1">▌ 180度轴线</label>
            <input id="space-axis-${i}" type="text"
              class="w-full bg-slate-900/60 border border-slate-700/40 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-gold-500/50"
              value="${escapeHtml(a.axisLine || '')}" placeholder="如：轴线沿走廊横向贯穿大门：A端 ←——→ B端" />
          </div>

          <div>
            <label class="block text-xs text-gold-400 mb-2">▌ 四个机位 · 详细说明</label>
            <div class="overflow-x-auto">
              <table class="w-full text-xs">
                <thead>
                  <tr class="text-[10px] text-gray-500">
                    <th class="text-center pb-1.5 pr-2 font-normal w-[5%]">#</th>
                    <th class="text-left pb-1.5 pr-2 font-normal w-[18%]">机位名称</th>
                    <th class="text-left pb-1.5 pr-2 font-normal w-[22%]">背景</th>
                    <th class="text-left pb-1.5 pr-2 font-normal w-[22%]">人物朝向</th>
                    <th class="text-left pb-1.5 font-normal w-[33%]" style="color:#6ee7b7">角色在画面里的位置</th>
                  </tr>
                </thead>
                <tbody>${facesRows}</tbody>
              </table>
            </div>
          </div>

          <div>
            <label class="block text-xs text-gold-400 mb-1">▌ 导演提示</label>
            <input id="space-notes-${i}" type="text"
              class="w-full bg-slate-900/60 border border-slate-700/40 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-gold-500/50"
              value="${escapeHtml(a.directorNotes || '')}" />
          </div>

        </div>
      </div>`;
    }).join('');
  });
}

// 老接口名兼容（旧代码可能调用）
function confirmSpaceDiagramModal() { return confirmSpaceReportPage(); }

// 用户点击"确认"后收集编辑内容并 resolve
function confirmSpaceReportPage() {
  const data = AppState._spaceModalData || [];
  const FACES_COUNT = 4;

  const updated = data.map((item, i) => {
    const flowEl    = document.getElementById(`space-flow-${i}`);
    const axisEl    = document.getElementById(`space-axis-${i}`);
    const notesEl   = document.getElementById(`space-notes-${i}`);

    const MARKERS = ['①', '②', '③', '④'];
    const shootingFaces = [];
    for (let fi = 0; fi < FACES_COUNT; fi++) {
      const nameEl    = document.getElementById(`face-name-${i}-${fi}`);
      const bgEl      = document.getElementById(`face-bg-${i}-${fi}`);
      const facingEl  = document.getElementById(`face-facing-${i}-${fi}`);
      const inframeEl = document.getElementById(`face-inframe-${i}-${fi}`);
      const name = nameEl?.value?.trim();
      if (name) {
        shootingFaces.push({
          marker:           MARKERS[fi] || '',
          name,
          background:       bgEl?.value?.trim()       || '',
          characterFacing:  facingEl?.value?.trim()   || '',
          characterInFrame: inframeEl?.value?.trim()  || ''
        });
      }
    }

    const spatialFlow = flowEl ? flowEl.value : (item.analysis.spatialFlow || item.analysis.spaceDescription || '');
    const updatedAnalysis = {
      ...item.analysis,
      spatialFlow,
      axisLine:      axisEl  ? axisEl.value  : item.analysis.axisLine,
      shootingFaces,
      directorNotes: notesEl ? notesEl.value : item.analysis.directorNotes,
      spaceDescription: spatialFlow
    };

    // 同步回 AppState.scenes
    const sceneIdx = AppState.scenes.findIndex(s => s.id === item.sceneId);
    if (sceneIdx !== -1) AppState.scenes[sceneIdx].spaceAnalysis = updatedAnalysis;

    return { ...item, analysis: updatedAnalysis };
  });

  if (AppState._spaceModalResolve) {
    // 回到 loading 页继续展示进度
    navigateTo('ai-loading');
    AppState._spaceModalResolve(updated);
    AppState._spaceModalResolve = null;
    AppState._spaceModalData = null;
  }
}

// ============ Agent 对话框 ============
function handleAgentInputKeydown(e) {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    sendAgentMessage();
  }
}

async function sendAgentMessage() {
  const input = document.getElementById('agentChatInput');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';

  appendAgentMessage('user', text);
  AgentState.messages.push({ role: 'user', content: text });

  const typingId = appendAgentMessage('assistant', '...', true);

  try {
    // 剥离图片数据，避免 base64 撑爆请求体
    const charsLite = AppState.characters.map(c => ({ id: c.id, name: c.name, height: c.height, props: c.props }));
    const scenesLite = AppState.scenes.map(s => ({ id: s.id, name: s.name }));
    const resp = await fetch(apiPath('/chat-agent'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: AgentState.messages,
        shots: AppState.analysis.shots,
        characters: charsLite,
        scenes: scenesLite
      })
    });
    const json = await resp.json();
    if (!resp.ok) throw new Error(json.error || '请求失败');

    const { content, tokens } = json;
    AgentState.messages.push({ role: 'assistant', content });
    AgentState.totalTokens += tokens.total || 0;

    // 对话气泡：剥离 JSON 代码块，只显示自然语言摘要
    const displayText = content.replace(/```json[\s\S]*?```/g, '').trim() || '已直接更新分镜提示词。';
    updateAgentMessage(typingId, displayText);

    const counter = document.getElementById('agentTokenCounter');
    const totalEl = document.getElementById('agentTotalTokens');
    if (counter) counter.classList.remove('hidden');
    if (totalEl) totalEl.textContent = AgentState.totalTokens.toLocaleString();

    // 解析并应用 JSON 更新块
    const jsonMatch = content.match(/```json\s*([\s\S]*?)```/);
    if (jsonMatch) {
      try {
        const updates = JSON.parse(jsonMatch[1]);
        if (updates.updates) applyAgentUpdates(updates.updates);
      } catch (_) {}
    }
  } catch (e) {
    updateAgentMessage(typingId, `⚠️ ${e.message}`);
  }
}

function appendAgentMessage(role, content, isTyping = false) {
  const container = document.getElementById('agentChatMessages');
  if (!container) return;
  const id = 'agent-msg-' + Date.now();
  const isUser = role === 'user';
  const div = document.createElement('div');
  div.id = id;
  div.className = `flex ${isUser ? 'justify-end' : 'justify-start'}`;
  div.innerHTML = `
    <div class="max-w-[85%] px-3 py-2 rounded-xl text-xs leading-relaxed ${isUser ? 'bg-gold-500/20 text-white' : 'bg-slate-800/60 text-gray-300'}">
      ${isTyping ? '<span class="animate-pulse">●●●</span>' : escapeHtml(content).replace(/\n/g, '<br>')}
    </div>`;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
  return id;
}

function updateAgentMessage(id, content) {
  const el = document.getElementById(id);
  if (!el) return;
  const bubble = el.querySelector('div');
  if (bubble) bubble.innerHTML = escapeHtml(content).replace(/\n/g, '<br>');
}

function applyAgentUpdates(updates) {
  if (!Array.isArray(updates)) return;
  let directPromptCount = 0;
  updates.forEach(u => {
    const idx = (u.shotNumber || 1) - 1;
    if (!AppState.analysis.shots[idx]) return;

    // ① 直接覆写整段提示词（最高优先级，对应聊天 Agent 改分镜流程）
    if (u.fullPrompt) {
      updateShotCardPrompt(idx, u.fullPrompt);
      directPromptCount++;
      return;
    }
    // ② 单字段修改（向后兼容）
    if (u.field) {
      AppState.analysis.shots[idx][u.field] = u.value;
      const el = document.getElementById(`field-${idx}-${u.field}`);
      if (el) el.textContent = u.value;
    }
  });
  if (directPromptCount > 0) {
    showToast(`✓ 已直接更新 ${directPromptCount} 个镜头的提示词`, 'success');
  } else {
    showToast(`✓ AI 已更新 ${updates.length} 处分镜`, 'success');
  }
}

// 用户手动编辑提示词文本时同步到 state
function onPromptEdit(index, el) {
  if (AppState.analysis.shots[index]) {
    AppState.analysis.shots[index].fullPrompt = el.innerText;
  }
}

function renderAssetGroup(type, items, containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';

  items.forEach(item => {
    const el = document.createElement('div');
    el.className = 'flex items-center gap-3 p-2 rounded-lg bg-slate-800/40 border border-slate-700/30 hover:border-gold-500/30 transition-colors';
    el.innerHTML = `
      <div class="w-10 h-10 rounded-lg ${item.image ? '' : 'bg-gradient-to-br from-slate-700 to-slate-800'} flex items-center justify-center overflow-hidden shrink-0">
        ${item.image
          ? `<img src="${item.image}" class="w-full h-full object-cover" />`
          : `<svg class="w-5 h-5 text-gray-500" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path d="${type === 'character' ? 'M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z' : 'M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z'}"/></svg>`
        }
      </div>
      <div class="flex-1 min-w-0">
        <p class="text-sm text-white truncate">${item.name}</p>
        ${item.height ? `<p class="text-xs text-gray-500">${item.height} ${item.props ? '| ' + item.props : ''}</p>` : ''}
      </div>
    `;
    container.appendChild(el);
  });
}

function renderSidebarAssets() {
  const charContainer = document.getElementById('sidebarCharacters');
  const sceneContainer = document.getElementById('sidebarScenes');
  if (!charContainer || !sceneContainer) return;

  charContainer.innerHTML = '';
  sceneContainer.innerHTML = '';

  AppState.characters.forEach(char => {
    const el = createSidebarAssetCard(char, 'character');
    charContainer.appendChild(el);
  });

  AppState.scenes.forEach(scene => {
    const el = createSidebarAssetCard(scene, 'scene');
    sceneContainer.appendChild(el);
  });
}

function createSidebarAssetCard(item, type) {
  const el = document.createElement('div');
  el.className = 'sidebar-asset';
  el.onmousedown = (e) => {
    e.preventDefault(); // 防止编辑器失焦
    insertAssetToEditor(item, type);
  };

  if (item.image) {
    el.innerHTML = `
      <img src="${item.image}" alt="${item.name}" />
      <div class="label">${item.name}</div>
    `;
  } else {
    el.innerHTML = `
      <div class="w-full h-full flex items-center justify-center bg-slate-800">
        <svg class="w-6 h-6 text-gray-600" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path d="${type === 'character' ? 'M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z' : 'M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z'}"/></svg>
      </div>
      <div class="label">${item.name}</div>
    `;
  }

  return el;
}

function insertAssetToEditor(item, type) {
  const editorId = AppState.activeEditorId;
  if (!editorId) {
    showToast('请先点击提示词编辑器获取焦点', 'warning');
    return;
  }

  const editor = document.getElementById(editorId);
  if (!editor) return;

  const prefix = type === 'character' ? '@' : '@';
  const imgHtml = item.image
    ? `<img src="${item.image}" style="width:18px;height:18px;border-radius:4px;object-fit:cover;vertical-align:middle;"/>`
    : '';
  const tagHtml = `<span class="asset-tag" contenteditable="false">${imgHtml}${prefix}[${item.name}]</span>&nbsp;`;

  editor.focus();
  document.execCommand('insertHTML', false, tagHtml);

  // 更新字数
  const index = parseInt(editorId.replace('editor-', ''));
  if (!isNaN(index)) updateEditorCharCount(index);
}

function addAsset(type) {
  if (type === 'character') openCharacterModal();
  else openSceneModal();
}

// ============ 分集视频页 ============
function renderEpisodes() {
  const grid = document.getElementById('episodeGrid');
  const empty = document.getElementById('episodeEmpty');

  if (AppState.generatedVideos.length === 0) {
    grid.innerHTML = '';
    grid.classList.add('hidden');
    empty.classList.remove('hidden');
    return;
  }

  empty.classList.add('hidden');
  grid.classList.remove('hidden');
  grid.innerHTML = '';

  AppState.generatedVideos.forEach((video, i) => {
    const card = document.createElement('div');
    card.className = 'video-card';
    card.innerHTML = `
      <div class="video-thumb">
        <svg class="w-16 h-16 text-slate-600 relative z-0" fill="none" stroke="currentColor" stroke-width="1" viewBox="0 0 24 24"><path d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>
        <div class="play-icon">
          <svg class="w-5 h-5 text-slate-950 ml-0.5" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
        </div>
      </div>
      <div class="video-info">
        <div class="flex items-center justify-between mb-1">
          <span class="text-sm font-semibold text-white">镜头 #${video.shotNumber}</span>
          <span class="text-xs text-gold-500">${video.resolution}</span>
        </div>
        <p class="text-xs text-gray-500 mb-3">${video.duration} | ${video.timestamp}</p>
        <div class="flex items-center gap-2">
          <button class="btn-secondary text-xs py-1 px-3 flex-1" onclick="navigateTo('shot-production')">编辑</button>
          <button class="btn-secondary text-xs py-1 px-3 flex-1" onclick="downloadVideo(${video.shotNumber - 1})">下载</button>
          <button class="btn-danger text-xs py-1 px-3" onclick="deleteEpisodeVideo(${i})">删除</button>
        </div>
      </div>
    `;
    grid.appendChild(card);
  });
}

function deleteEpisodeVideo(index) {
  showModal({
    title: '确认删除',
    message: '确定要删除这个视频片段吗？此操作不可撤销。',
    confirmText: '确认删除',
    isDanger: true,
    onConfirm: () => {
      AppState.generatedVideos.splice(index, 1);
      renderEpisodes();
      showToast('视频已删除', 'success');
    }
  });
}

// ============ 积分系统 ============
function deductCredits(amount) {
  // 方案B时扣除10%系统维护积分
  let actualAmount = amount;
  if (AppState.plan === 'B') {
    const maintenance = Math.ceil(amount * 0.1);
    actualAmount = maintenance;
    showToast(`系统维护积分：${maintenance.toLocaleString()}（操作原价 ${amount.toLocaleString()} 的 10%）`, 'warning');
  }
  AppState.credits = Math.max(0, AppState.credits - actualAmount);
  AppState.creditsUsed += actualAmount;
  updateCreditsDisplay();
}

function updateCreditsDisplay() {
  const formatted = AppState.credits.toLocaleString();
  const el = document.getElementById('creditsDisplay');
  const userEl = document.getElementById('userCreditsDisplay');
  const usedEl = document.getElementById('userCreditsUsed');
  if (el) el.textContent = formatted;
  if (userEl) userEl.textContent = formatted;
  if (usedEl) usedEl.textContent = AppState.creditsUsed.toLocaleString();

  // 更新用户中心方案显示
  const planEl = document.getElementById('userCurrentPlan');
  if (planEl) {
    planEl.textContent = AppState.plan === 'A' ? '方案 A：平台代付' : '方案 B：自有 Key';
  }
}

// ============ 设置页 A/B方案切换 ============
function switchPlan(plan) {
  AppState.plan = plan;

  document.getElementById('planTabA').classList.toggle('active', plan === 'A');
  document.getElementById('planTabB').classList.toggle('active', plan === 'B');

  document.getElementById('planA').classList.toggle('hidden', plan !== 'A');
  document.getElementById('planB').classList.toggle('hidden', plan !== 'B');
}

function saveSettings() {
  if (AppState.plan === 'B') {
    const analysisKey = document.getElementById('planB_analysisApiKey').value;
    const videoKey = document.getElementById('planB_videoApiKey').value;
    if (!analysisKey && !videoKey) {
      showToast('请至少填写一个 API Key', 'warning');
      return;
    }
  }
  showToast('设置已保存', 'success');
  updateCreditsDisplay();
  const back = AppState.previousPage && AppState.previousPage !== 'settings' ? AppState.previousPage : 'new-project';
  navigateTo(back);
}

// ============ 设置页工具 ============
function togglePasswordVisibility(inputId) {
  const input = document.getElementById(inputId);
  input.type = input.type === 'password' ? 'text' : 'password';
}

function copyReferralCode() {
  navigator.clipboard.writeText('DREAM-X8K2M').then(() => {
    showToast('推荐码已复制到剪贴板', 'success');
  }).catch(() => {
    showToast('复制失败，请手动复制', 'error');
  });
}

// ============ 分集视频子Tab切换 ============
function switchEpisodeTab(tabId) {
  ['videos', 'analysis', 'assets'].forEach(id => {
    const el = document.getElementById('episodeTab-' + id);
    if (el) el.classList.toggle('hidden', id !== tabId);
  });

  document.querySelectorAll('.sub-nav-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.subtab === tabId);
  });

  // 渲染子Tab内容
  if (tabId === 'videos') renderEpisodes();
  if (tabId === 'analysis') renderEpisodeAnalysisSummary();
  if (tabId === 'assets') renderEpisodeAssets();
}

function renderEpisodeAnalysisSummary() {
  const container = document.getElementById('episodeAnalysisSummary');
  if (!AppState.hasAnalysis) {
    container.innerHTML = '<p class="text-gray-500 text-sm">暂无剧本分析数据，请先在新建项目页面进行剧本分析。</p>';
    return;
  }
  container.innerHTML = `
    <div class="space-y-3">
      <div><span class="text-xs text-gold-500">剧本名：</span><span class="text-sm text-white">${AppState.analysis.title}</span></div>
      <div><span class="text-xs text-gold-500">题材：</span><span class="text-sm text-gray-300">${AppState.analysis.genre}</span></div>
      <div><span class="text-xs text-gold-500">梗概：</span><p class="text-sm text-gray-400 mt-1">${AppState.analysis.synopsis}</p></div>
      <div><span class="text-xs text-gold-500">镜头数：</span><span class="text-sm text-gray-300">${AppState.analysis.shots.length} 个片段</span></div>
    </div>
  `;
}

function renderEpisodeAssets() {
  const charList = document.getElementById('episodeCharacterList');
  const sceneList = document.getElementById('episodeSceneList');

  if (charList) {
    charList.innerHTML = AppState.characters.length === 0
      ? '<p class="text-xs text-gray-500">暂无角色数据</p>'
      : AppState.characters.map(c => `
        <div class="flex items-center gap-3 p-2 rounded-lg bg-slate-800/40 border border-slate-700/30">
          <div class="w-10 h-10 rounded-lg ${c.image ? '' : 'bg-gradient-to-br from-slate-700 to-slate-800'} flex items-center justify-center overflow-hidden shrink-0">
            ${c.image ? `<img src="${c.image}" class="w-full h-full object-cover"/>` : '<svg class="w-5 h-5 text-gray-500" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/></svg>'}
          </div>
          <div class="flex-1 min-w-0">
            <p class="text-sm text-white truncate">${c.name}</p>
            <p class="text-xs text-gray-500">${c.height || ''} ${c.props ? '| ' + c.props : ''}</p>
          </div>
        </div>
      `).join('');
  }

  if (sceneList) {
    sceneList.innerHTML = AppState.scenes.length === 0
      ? '<p class="text-xs text-gray-500">暂无场景数据</p>'
      : AppState.scenes.map(s => `
        <div class="flex items-center gap-3 p-2 rounded-lg bg-slate-800/40 border border-slate-700/30">
          <div class="w-10 h-10 rounded-lg ${s.image ? '' : 'bg-gradient-to-br from-slate-700 to-slate-800'} flex items-center justify-center overflow-hidden shrink-0">
            ${s.image ? `<img src="${s.image}" class="w-full h-full object-cover"/>` : '<svg class="w-5 h-5 text-gray-500" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>'}
          </div>
          <div class="flex-1 min-w-0">
            <p class="text-sm text-white truncate">${s.name}</p>
          </div>
        </div>
      `).join('');
  }
}

// ============ 角色弹窗 ============
function openCharacterModal(editId) {
  AppState._editingCharId = editId || null;
  const existing = editId ? AppState.characters.find(c => c.id === editId) : null;
  AppState._charModalImage = existing?.image || null;
  document.getElementById('charModalName').value = existing?.name || '';
  document.getElementById('charModalHeight').value = existing?.height || '';
  document.getElementById('charModalProps').value = existing?.props || '';
  document.getElementById('charModalPreview').innerHTML = existing?.image
    ? `<img src="${existing.image}" class="w-20 h-20 rounded-lg object-cover mx-auto cursor-pointer" onclick="document.getElementById('charModalFileInput').click()"/><p class="text-xs text-gray-500 mt-1">点击更换图片</p>`
    : `<svg class="w-8 h-8 text-gray-600 mx-auto mb-2" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg><p class="text-xs text-gray-500">点击上传角色图片</p>`;
  const title = document.querySelector('#characterModal h3');
  if (title) title.textContent = existing ? '编辑角色' : '上传角色';
  const modal = document.getElementById('characterModal');
  modal.classList.remove('hidden');
  modal.style.display = 'flex';
}

function closeCharacterModal() {
  const modal = document.getElementById('characterModal');
  modal.classList.add('hidden');
  modal.style.display = 'none';
}

function previewCharModalImage(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    AppState._charModalImage = e.target.result;
    document.getElementById('charModalPreview').innerHTML = `
      <img src="${e.target.result}" class="w-20 h-20 rounded-lg object-cover mx-auto cursor-pointer" onclick="document.getElementById('charModalFileInput').click()" />
      <p class="text-xs text-gray-500 mt-1">点击更换图片</p>
    `;
  };
  reader.readAsDataURL(file);
}

function saveCharacterFromModal() {
  const name = document.getElementById('charModalName').value.trim();
  if (!name) {
    showToast('请输入角色名称', 'warning');
    return;
  }
  const payload = {
    name,
    height: document.getElementById('charModalHeight').value.trim(),
    props: document.getElementById('charModalProps').value.trim(),
    image: AppState._charModalImage
  };
  if (AppState._editingCharId) {
    const idx = AppState.characters.findIndex(c => c.id === AppState._editingCharId);
    if (idx !== -1) AppState.characters[idx] = { ...AppState.characters[idx], ...payload };
    showToast(`角色 "${name}" 已更新`, 'success');
  } else {
    AppState.characters.push({ id: Date.now(), ...payload });
    showToast(`角色 "${name}" 已添加`, 'success');
  }
  renderAnalysisPageAssets();
  renderAssetsPage();
  if (AppState.currentPage === 'shot-production') renderSidebarAssets();
  closeCharacterModal();
}

// ============ 场景弹窗 ============
function openSceneModal(editId) {
  AppState._editingSceneId = editId || null;
  const existing = editId ? AppState.scenes.find(s => s.id === editId) : null;
  AppState._sceneModalImage1 = existing?.image || null;
  AppState._sceneModalImage2 = existing?.imageReverse || null;
  document.getElementById('sceneModalName').value = existing?.name || '';
  const title = document.querySelector('#sceneModal h3');
  if (title) title.textContent = existing ? '编辑场景' : '上传场景';
  document.getElementById('sceneModalPreview1').innerHTML = `
    <svg class="w-6 h-6 text-gray-600 mx-auto mb-1" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>
    <p class="text-xs text-gray-500">上传正面图</p>
  `;
  document.getElementById('sceneModalPreview2').innerHTML = `
    <svg class="w-6 h-6 text-gray-600 mx-auto mb-1" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>
    <p class="text-xs text-gray-500">上传反打图</p>
  `;
  const modal = document.getElementById('sceneModal');
  modal.classList.remove('hidden');
  modal.style.display = 'flex';
}

function closeSceneModal() {
  const modal = document.getElementById('sceneModal');
  modal.classList.add('hidden');
  modal.style.display = 'none';
}

function previewSceneModalImage(event, index) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    if (index === 1) AppState._sceneModalImage1 = e.target.result;
    else AppState._sceneModalImage2 = e.target.result;

    document.getElementById('sceneModalPreview' + index).innerHTML = `
      <img src="${e.target.result}" class="w-16 h-12 rounded object-cover mx-auto cursor-pointer" onclick="document.getElementById('sceneModalFileInput${index}').click()" />
      <p class="text-xs text-gray-500 mt-1">点击更换</p>
    `;
  };
  reader.readAsDataURL(file);
}

function saveSceneFromModal() {
  const name = document.getElementById('sceneModalName').value.trim();
  if (!name) {
    showToast('请输入场景名称', 'warning');
    return;
  }
  const newScene = {
    id: Date.now(),
    name: name,
    image: AppState._sceneModalImage1,
    imageReverse: AppState._sceneModalImage2,
    spaceAnalysis: null  // 待 AI 分析后填充
  };
  if (AppState._editingSceneId) {
    const idx = AppState.scenes.findIndex(s => s.id === AppState._editingSceneId);
    if (idx !== -1) {
      AppState.scenes[idx] = {
        ...AppState.scenes[idx],
        name,
        image: AppState._sceneModalImage1,
        imageReverse: AppState._sceneModalImage2,
        spaceAnalysis: AppState.scenes[idx].spaceAnalysis || null  // 保留已有分析
      };
    }
    showToast(`场景 "${name}" 已更新`, 'success');
  } else {
    AppState.scenes.push(newScene);
    showToast(`场景 "${name}" 已添加`, 'success');
  }
  renderAnalysisPageAssets();
  renderAssetsPage();
  if (AppState.currentPage === 'shot-production') renderSidebarAssets();
  closeSceneModal();
}

// ============ 场景空间分析（ARK 视觉模型）============
async function analyzeSceneSpace(sceneId) {
  const scene = AppState.scenes.find(s => s.id === sceneId);
  if (!scene) return;

  // 更新按钮状态
  const btn = document.getElementById(`analyze-space-btn-${sceneId}`);
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<svg class="w-3 h-3 animate-spin" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg> 分析中...`;
  }

  try {
    let resp;
    if (scene.image) {
      // 有参考图：用视觉模型（同时带剧本上下文，让人物按剧本站到图中空间里）
      const scriptText = AppState.analysis.originalScript || AppState.scriptText || '';
      const shots = AppState.analysis.shots || [];
      const shotDescs = shots
        .filter(s => s.scene && s.scene.includes(scene.name))
        .map(s => s.action_desc)
        .filter(Boolean);
      resp = await fetch(apiPath('/analyze-scene-space'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageBase64: scene.image, sceneName: scene.name, scriptText, shotDescriptions: shotDescs })
      });
    } else {
      // 无参考图：从剧本文字推断
      const scriptText = AppState.analysis.originalScript || AppState.scriptText || '';
      const shots = AppState.analysis.shots || [];
      const shotDescs = shots
        .filter(s => s.scene && s.scene.includes(scene.name))
        .map(s => s.action_desc)
        .filter(Boolean);
      resp = await fetch(apiPath('/analyze-scene-space-from-script'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sceneName: scene.name, scriptText, shotDescriptions: shotDescs })
      });
    }
    const json = await resp.json();
    if (!resp.ok) throw new Error(json.error || '分析失败');

    // 存入场景数据
    const idx = AppState.scenes.findIndex(s => s.id === sceneId);
    if (idx !== -1) AppState.scenes[idx].spaceAnalysis = json.data;

    // 刷新显示
    renderAssetsPage();
    renderAnalysisPageAssets();
    if (AppState.currentPage === 'shot-production') renderSidebarAssets();

    showToast(`✓ 场景「${scene.name}」空间理解报告生成完成，共 ${json.data.shootingFaces?.length || 0} 个拍摄面`, 'success');
  } catch (e) {
    showToast('空间分析失败：' + e.message, 'error');
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '🗺️ AI分析空间';
    }
  }
}

// ============ 登录弹窗 ============
function openLoginModal() {
  const modal = document.getElementById('loginModal');
  modal.classList.remove('hidden');
  modal.style.display = 'flex';
}

function closeLoginModal() {
  const modal = document.getElementById('loginModal');
  modal.classList.add('hidden');
  modal.style.display = 'none';
}

function mockLogin() {
  AppState.isLoggedIn = true;
  closeLoginModal();
  showToast('登录成功！欢迎回来', 'success');
  // 自动触发分析流程
  handleAnalyzeScript();
}

// ============ 模态弹窗 ============
function showModal({ title, message, confirmText = '确认', onConfirm, isDanger = false }) {
  const overlay = document.getElementById('modalOverlay');
  const content = document.getElementById('modalContent');

  content.innerHTML = `
    <h3 class="text-lg font-semibold text-white mb-3 font-display">${title}</h3>
    <p class="text-sm text-gray-400 mb-6 whitespace-pre-line">${message}</p>
    <div class="flex justify-end gap-3">
      <button class="btn-secondary" onclick="hideModal()">取消</button>
      <button class="${isDanger ? 'btn-danger' : 'btn-primary'}" id="modalConfirmBtn">${confirmText}</button>
    </div>
  `;

  document.getElementById('modalConfirmBtn').onclick = () => {
    hideModal();
    if (onConfirm) onConfirm();
  };

  overlay.classList.remove('hidden');
  overlay.classList.add('show');
}

function hideModal() {
  const overlay = document.getElementById('modalOverlay');
  overlay.classList.add('hidden');
  overlay.classList.remove('show');
}

// 点击遮罩关闭
document.getElementById('modalOverlay')?.addEventListener('click', (e) => {
  if (e.target === e.currentTarget) hideModal();
});

// ============ 全屏 Loading ============
function showFullscreenLoading(text) {
  const el = document.getElementById('fullscreenLoading');
  document.getElementById('loadingText').textContent = text || 'AI 正在处理中...';
  el.classList.remove('hidden');
  el.style.display = 'flex';
}

function hideFullscreenLoading() {
  const el = document.getElementById('fullscreenLoading');
  el.classList.add('hidden');
  el.style.display = 'none';
}

// ============ Toast 提示 ============
function showToast(message, type = 'success') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// ============ 工具函数 ============
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ============ API Key 管理 ============
function getApiKey() {
  return localStorage.getItem('anthropicApiKey') || '';
}

function saveAnthropicKey() {
  const key = document.getElementById('anthropicApiKey').value.trim();
  if (!key) {
    showToast('请填写 API Key', 'warning');
    return;
  }
  localStorage.setItem('anthropicApiKey', key);
  showToast('Anthropic API Key 已保存', 'success');
}

// ============ 剧本文件上传（点击按钮） ============
function handleFileUpload(event) {
  const file = event.target.files[0];
  if (!file) return;
  event.target.value = '';
  handleFileFromObject(file);
}

function fillScriptTextarea(text, filename) {
  const textarea = document.getElementById('scriptInput');
  textarea.value = text;
  AppState.scriptText = text;
  textarea.dispatchEvent(new Event('input'));
  showToast(`✓ 已读入《${filename}》，共 ${text.length.toLocaleString()} 字符`, 'success');
}

// ============ AI 工作流 - 工具函数 ============
function updateWorkflowStep(stepId, state) {
  const badge = document.getElementById(`wf-badge-${stepId}`);
  if (!badge) return;
  badge.className = 'step-badge';
  if (state === 'done') {
    badge.classList.add('done');
    badge.textContent = '✓';
  } else if (state === 'spinning') {
    badge.classList.add('spinning');
    badge.textContent = '⟳';
  } else if (state === 'active') {
    badge.classList.add('active');
    badge.textContent = stepId;
  }
}

function enableWorkflowButton(btnId, enabled) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  btn.disabled = !enabled;
  btn.classList.toggle('opacity-40', !enabled);
  btn.classList.toggle('cursor-not-allowed', !enabled);
}

function updateShotCardPrompt(index, promptText) {
  // 拆分 AI 返回的完整提示词：全局部分 → globalPromptOverride；单镜头部分 → shot.fullPrompt
  if (promptText && promptText.includes('# 分镜')) {
    const parts = promptText.split(/(?=# 分镜)/);
    const globalPart = parts.slice(0, -1).join('').trim();
    const shotPart = parts[parts.length - 1].trim();
    if (globalPart && globalPart.includes('【全局强制规则】')) {
      AppState.globalPromptOverride = globalPart.split(/(?=# 参考图标注)/)[0].trim();
    }
    if (AppState.analysis.shots[index]) AppState.analysis.shots[index].fullPrompt = shotPart;
  } else if (AppState.analysis.shots[index]) {
    AppState.analysis.shots[index].fullPrompt = promptText;
  }

  const card = document.getElementById(`shot-card-${index}`);
  if (card) {
    const badge = card.querySelector('.prompt-ready-badge');
    if (badge) badge.classList.remove('hidden');
  }
  // 更新气泡编辑器（显示 参考图标注 + 分镜 块）
  const editor = document.getElementById(`editor-${index}`);
  const shot = AppState.analysis.shots[index];
  if (editor && shot) {
    const refBlock  = buildRefBlock(shot);
    const shotBlock = extractShotBlock(shot);
    editor.textContent = refBlock + '\n\n' + shotBlock;
  }
  // 同步刷新顶部全局编辑器
  const globalEditor = document.getElementById('globalBoxEditor');
  if (globalEditor) globalEditor.textContent = buildGlobalBlock();
}

function togglePromptEditor(index) {
  const panel = document.getElementById(`prompt-panel-${index}`);
  const arrow = document.getElementById(`prompt-arrow-${index}`);
  if (!panel) return;
  const hidden = panel.classList.toggle('hidden');
  if (arrow) arrow.style.transform = hidden ? '' : 'rotate(180deg)';
}

// ============ Step 1: 总导演建分镜 ============
async function handleCreateShots() {
  if (!AppState.hasAnalysis) {
    showToast('请先完成剧本分析', 'warning');
    return;
  }
  const apiKey = getApiKey();
  if (AppState.plan !== 'A' && !apiKey) {
    showToast('请先在设置中填写 Anthropic API Key', 'warning');
    navigateTo('settings');
    return;
  }

  updateWorkflowStep(1, 'spinning');
  enableWorkflowButton('wfBtn1', false);
  showFullscreenLoading('总导演正在制定工业级分镜方案...');

  try {
    const resp = await fetch(apiPath('/create-shots'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        analysis: AppState.analysis,
        videoStyle: AppState.videoStyle,
        shotStyle: AppState.shotStyle,
        aspectRatio: AppState.aspectRatio,
        apiKey,
        plan: AppState.plan
      })
    });

    const json = await resp.json();
    if (!resp.ok) throw new Error(json.error || '总导演分析失败');

    WorkflowState.shots = json.data.shots;
    AppState.analysis.shots = json.data.shots;
    renderShotCards();

    updateWorkflowStep(1, 'done');
    enableWorkflowButton('wfBtn2', true);
    document.getElementById('wfBtn2').classList.remove('opacity-40', 'cursor-not-allowed');
    WorkflowState.step1Done = true;
    hideFullscreenLoading();
    showToast(`✓ 总导演已完成 ${json.data.shots.length} 个专业分镜`, 'success');
  } catch (e) {
    updateWorkflowStep(1, 'active');
    enableWorkflowButton('wfBtn1', true);
    hideFullscreenLoading();
    showToast('总导演失败：' + e.message, 'error');
  }
}

// ============ Step 2: AI导演写提示词 ============
async function handleWritePrompts() {
  if (!WorkflowState.step1Done) {
    showToast('请先完成「总导演建分镜」', 'warning');
    return;
  }
  const apiKey = getApiKey();
  if (AppState.plan !== 'A' && !apiKey) { navigateTo('settings'); return; }

  updateWorkflowStep(2, 'spinning');
  enableWorkflowButton('wfBtn2', false);
  showFullscreenLoading('AI导演正在写 Seedance 2.0 提示词...');

  try {
    const resp = await fetch(apiPath('/write-prompts'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        shots: WorkflowState.shots,
        videoStyle: AppState.videoStyle,
        characters: AppState.characters.map(c => ({ id: c.id, name: c.name, height: c.height, props: c.props })),
        scenes: AppState.scenes.map(s => ({ id: s.id, name: s.name })),
        aspectRatio: AppState.aspectRatio,
        shotRules: AppState.analysis.shotRules,
        apiKey,
        plan: AppState.plan
      })
    });

    const json = await resp.json();
    if (!resp.ok) throw new Error(json.error || 'AI导演失败');

    WorkflowState.prompts = json.data.prompts;

    json.data.prompts.forEach((p) => {
      const idx = findShotIndex(p.shotNumber);
      if (idx < 0 || !AppState.analysis.shots[idx]) return;
      AppState.analysis.shots[idx].prompt = p.prompt;
      updateShotCardPrompt(idx, p.prompt);
    });

    updateWorkflowStep(2, 'done');
    enableWorkflowButton('wfBtn3', true);
    document.getElementById('wfBtn3').classList.remove('opacity-40', 'cursor-not-allowed');
    WorkflowState.step2Done = true;
    hideFullscreenLoading();
    showToast(`✓ AI导演提示词已写入 ${json.data.prompts.length} 个镜头`, 'success');
  } catch (e) {
    updateWorkflowStep(2, 'active');
    enableWorkflowButton('wfBtn2', true);
    hideFullscreenLoading();
    showToast('AI导演失败：' + e.message, 'error');
  }
}

// ============ Step 3: 总导演检查 ============
async function handleReviewPrompts() {
  if (!WorkflowState.step2Done) {
    showToast('请先完成「即梦写提示词」', 'warning');
    return;
  }
  const apiKey = getApiKey();
  if (!apiKey) { navigateTo('settings'); return; }

  updateWorkflowStep(3, 'spinning');
  enableWorkflowButton('wfBtn3', false);
  showFullscreenLoading('总导演正在检查连贯性、专业性与视听语言...');

  try {
    const resp = await fetch(apiPath('/review-prompts'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompts: WorkflowState.prompts,
        shots: WorkflowState.shots,
        apiKey
      })
    });

    const json = await resp.json();
    if (!resp.ok) throw new Error(json.error || '总导演检查失败');

    WorkflowState.reviews = json.data;
    renderReviewReport(json.data);

    updateWorkflowStep(3, 'done');
    enableWorkflowButton('wfBtn4', true);
    document.getElementById('wfBtn4').classList.remove('opacity-40', 'cursor-not-allowed');
    WorkflowState.step3Done = true;
    hideFullscreenLoading();
    showToast(`✓ 总导演检查完成，综合评分 ${json.data.overallScore || '—'}/10`, 'success');
  } catch (e) {
    updateWorkflowStep(3, 'active');
    enableWorkflowButton('wfBtn3', true);
    hideFullscreenLoading();
    showToast('总导演检查失败：' + e.message, 'error');
  }
}

// ============ Step 4: AI导演修改 ============
async function handleRevisePrompts() {
  if (!WorkflowState.step3Done) {
    showToast('请先完成「总导演检查」', 'warning');
    return;
  }
  const apiKey = getApiKey();
  if (!apiKey) { navigateTo('settings'); return; }

  updateWorkflowStep(4, 'spinning');
  enableWorkflowButton('wfBtn4', false);
  showFullscreenLoading('AI导演正在根据总导演意见修改提示词...');

  try {
    const resp = await fetch(apiPath('/revise-prompts'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompts: WorkflowState.prompts,
        reviews: WorkflowState.reviews,
        shots: WorkflowState.shots,
        apiKey
      })
    });

    const json = await resp.json();
    if (!resp.ok) throw new Error(json.error || '即梦修改失败');

    WorkflowState.prompts = json.data.prompts;

    let revisedCount = 0;
    json.data.prompts.forEach((p) => {
      const idx = findShotIndex(p.shotNumber);
      if (idx < 0 || !AppState.analysis.shots[idx]) return;
      if (p.revised !== false) {
        revisedCount++;
        updateShotCardPrompt(idx, p.prompt);
        AppState.analysis.shots[idx].prompt = p.prompt;
      }
    });

    updateWorkflowStep(4, 'done');
    WorkflowState.step4Done = true;

    // 点亮"提示词就绪"
    const doneBadge = document.getElementById('wf-badge-done');
    if (doneBadge) { doneBadge.classList.add('done'); doneBadge.textContent = '✓'; }

    hideFullscreenLoading();
    showToast(`🎬 提示词就绪！AI导演修改了 ${revisedCount} 个镜头`, 'success');
  } catch (e) {
    updateWorkflowStep(4, 'active');
    enableWorkflowButton('wfBtn4', true);
    hideFullscreenLoading();
    showToast('即梦修改失败：' + e.message, 'error');
  }
}

// ============ 渲染总导演检查报告 ============
function renderReviewReport(reviewData) {
  const reportEl = document.getElementById('reviewReport');
  const contentEl = document.getElementById('reviewContent');
  if (!reportEl || !contentEl) return;

  contentEl.innerHTML = `
    <div class="mb-3 pb-2 border-b border-slate-700/30">
      <span class="text-gray-300">综合评分：</span>
      <span class="text-gold-400 font-bold">${reviewData.overallScore || '—'}/10</span>
      <p class="text-gray-500 mt-1">${reviewData.overall || ''}</p>
    </div>
    ${(reviewData.reviews || []).map(r => `
      <div class="py-1.5 border-b border-slate-700/20">
        <span class="text-gray-300 text-xs font-medium">镜头 #${r.shotNumber}</span>
        <span class="ml-2 text-xs ${r.score >= 8 ? 'text-green-400' : r.score >= 6 ? 'text-yellow-400' : 'text-red-400'}">${r.score}/10</span>
        ${r.issues && r.issues.length ? `<p class="text-red-400 text-xs mt-0.5">⚠ ${r.issues.join('；')}</p>` : ''}
        ${r.suggestions && r.suggestions.length ? `<p class="text-blue-400 text-xs mt-0.5">→ ${r.suggestions.join('；')}</p>` : ''}
      </div>
    `).join('')}
  `;

  reportEl.classList.remove('hidden');
}
