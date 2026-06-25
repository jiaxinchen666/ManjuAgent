const fs = require('fs');
const path = require('path');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3100';
const ROOT = __dirname;
const SCRIPT_PATH = process.env.SCRIPT_PATH || path.join(ROOT, '..', 'test_agent_smoke_script.txt');
const VIDEO_STYLE = process.env.VIDEO_STYLE || '真人写实';
const SHOT_STYLE = process.env.SHOT_STYLE || '悬疑';
const ASPECT_RATIO = process.env.ASPECT_RATIO || '9:16';
const OUT_DIR = path.join(ROOT, 'test-results', `smoke-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 15000);
const MAX_VIDEO_POLLS = Number(process.env.MAX_VIDEO_POLLS || 80);

fs.mkdirSync(OUT_DIR, { recursive: true });

const results = [];

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  fs.appendFileSync(path.join(OUT_DIR, 'run.log'), line + '\n');
}

function saveJson(name, value) {
  fs.writeFileSync(path.join(OUT_DIR, `${name}.json`), JSON.stringify(value, null, 2), 'utf-8');
}

async function requestJson(name, url, options = {}) {
  const started = Date.now();
  log(`START ${name}`);
  const resp = await fetch(`${BASE_URL}${url}`, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });
  const text = await resp.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  saveJson(name, json);
  const elapsedMs = Date.now() - started;
  const ok = resp.ok && json.error === undefined;
  results.push({ name, ok, status: resp.status, elapsedMs });
  log(`${ok ? 'PASS' : 'FAIL'} ${name} status=${resp.status} elapsed=${Math.round(elapsedMs / 1000)}s`);
  if (!ok) {
    throw new Error(`${name} failed: HTTP ${resp.status} ${JSON.stringify(json).slice(0, 500)}`);
  }
  return json;
}

function pickFirstPrompt(directorData, revisedData) {
  const revisedPrompt = revisedData?.prompts?.find(p => p.prompt)?.prompt;
  if (revisedPrompt) return revisedPrompt;
  const firstShot = directorData?.shots?.[0];
  if (firstShot?.singlePrompt) return firstShot.singlePrompt;
  if (firstShot?.fullPrompt) return firstShot.fullPrompt;
  return [
    `${ASPECT_RATIO}，10秒，${VIDEO_STYLE}。`,
    '主角站在发光的城市天台边缘，另一名角色从霓虹广告牌阴影后出现，风吹动衣摆。',
    '无字幕、无文字、无水印，缓慢推镜，环境音为城市风声、远处列车声和轻微电流声。'
  ].join('');
}

async function pollVideo(taskId) {
  for (let i = 1; i <= MAX_VIDEO_POLLS; i++) {
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    const json = await requestJson(`video-query-${String(i).padStart(2, '0')}`, `/api/video-task/${encodeURIComponent(taskId)}`);
    const task = json.task || {};
    const status = task.status || task.task_status || 'unknown';
    log(`VIDEO task=${taskId} poll=${i}/${MAX_VIDEO_POLLS} status=${status}`);
    if (status === 'succeeded') return task;
    if (status === 'failed' || status === 'cancelled') {
      throw new Error(`Seedance task ${status}: ${JSON.stringify(task.error || task.message || task).slice(0, 800)}`);
    }
  }
  throw new Error(`Seedance task did not finish after ${MAX_VIDEO_POLLS} polls`);
}

async function main() {
  const script = fs.readFileSync(SCRIPT_PATH, 'utf-8');
  saveJson('input-script', { path: SCRIPT_PATH, script, videoStyle: VIDEO_STYLE, shotStyle: SHOT_STYLE, aspectRatio: ASPECT_RATIO });

  const health = await requestJson('health', '/api/health');

  const analysisResp = await requestJson('analyze-script', '/api/analyze-script', {
    method: 'POST',
    body: JSON.stringify({
      script,
      videoStyle: VIDEO_STYLE,
      shotStyle: SHOT_STYLE,
      projectName: 'agent smoke test'
    })
  });
  const analysis = analysisResp.data;

  const shotDescriptions = (analysis.shots || []).slice(0, 8).map(s => s.action_desc || s.action || '').filter(Boolean);
  const sceneSpaceResp = await requestJson('analyze-scene-space-from-script', '/api/analyze-scene-space-from-script', {
    method: 'POST',
    body: JSON.stringify({
      sceneName: '废弃地铁站',
      scriptText: script,
      shotDescriptions
    })
  });

  const sceneSpaceAnalyses = [{
    sceneName: '废弃地铁站',
    analysis: sceneSpaceResp.data
  }];

  const directorResp = await requestJson('director-prompts', '/api/director-prompts', {
    method: 'POST',
    body: JSON.stringify({
      analysis,
      videoStyle: VIDEO_STYLE,
      shotStyle: SHOT_STYLE,
      aspectRatio: ASPECT_RATIO,
      sceneSpaceAnalyses,
      shotRules: '',
      styleGuide: '',
      worldview: ''
    })
  });
  const directorData = directorResp.data;
  const shots = (directorData.shots || []).slice(0, 3);
  const prompts = shots.map((shot, idx) => ({
    shotNumber: shot.shotNumber || idx + 1,
    prompt: shot.singlePrompt || shot.fullPrompt || ''
  }));

  const reviewResp = await requestJson('review-prompts', '/api/review-prompts', {
    method: 'POST',
    body: JSON.stringify({ prompts, shots })
  });

  const reviseResp = await requestJson('revise-prompts', '/api/revise-prompts', {
    method: 'POST',
    body: JSON.stringify({ prompts, reviews: reviewResp.data, shots })
  });

  const chatResp = await requestJson('chat-agent', '/api/chat-agent', {
    method: 'POST',
    body: JSON.stringify({
      messages: [{ role: 'user', content: '把第一镜改成更明显的缓慢推镜，并增强门缝冷雾的压迫感。' }],
      shots: shots.map((shot, idx) => ({ ...shot, fullPrompt: prompts[idx]?.prompt || '' })),
      characters: [],
      scenes: []
    })
  });

  const videoPrompt = pickFirstPrompt(directorData, reviseResp.data);
  saveJson('video-prompt-used', { prompt: videoPrompt });

  const createVideoResp = await requestJson('generate-video', '/api/generate-video', {
    method: 'POST',
    body: JSON.stringify({
      prompt: videoPrompt,
      shotNumber: 1,
      ratio: ASPECT_RATIO,
      duration: 10,
      generateAudio: true,
      watermark: false
    })
  });

  const taskId = createVideoResp.taskId;
  const videoTask = await pollVideo(taskId);
  saveJson('video-task-succeeded', videoTask);

  const downloadResp = await requestJson('video-download', `/api/video-task/${encodeURIComponent(taskId)}/download`, {
    method: 'POST',
    body: JSON.stringify({ shotNumber: 1 })
  });

  const videoPath = downloadResp.path;
  const videoExists = videoPath && fs.existsSync(videoPath);
  const videoSize = videoExists ? fs.statSync(videoPath).size : 0;
  saveJson('summary', {
    ok: true,
    baseUrl: BASE_URL,
    outDir: OUT_DIR,
    health,
    analysisShots: analysis.shots?.length || 0,
    directorShots: directorData.shots?.length || 0,
    reviewedPrompts: reviewResp.data?.reviews?.length || 0,
    revisedPrompts: reviseResp.data?.prompts?.length || 0,
    chatReturnedUpdates: /```json/.test(chatResp.content || ''),
      seedanceTaskId: taskId,
      downloadedVideoUrl: downloadResp.url,
      downloadedVideoPath: videoPath,
      downloadedVideoBytes: videoSize,
    results
  });
  log(`DONE video=${videoPath || downloadResp.url} bytes=${videoSize}`);
}

main().catch(err => {
  saveJson('summary', { ok: false, error: err.message, results });
  log(`ERROR ${err.stack || err.message}`);
  process.exitCode = 1;
});
