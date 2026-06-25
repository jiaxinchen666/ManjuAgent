/* ========== 造梦大师 - 服务器端配置 ========== */
/* API keys are read from environment variables only. */

module.exports = {
  deepseekKey: process.env.DEEPSEEK_API_KEY || '',
  deepseekBaseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
  deepseekModel: process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash',

  // ARK 视觉大模型（火山引擎 doubao-seed-2-0-pro）——用于分析场景图空间结构、生成机位图
  arkKey: process.env.ARK_API_KEY || '',
  arkResponsesUrl: 'https://ark.cn-beijing.volces.com/api/v3/responses',
  arkSpaceModel: process.env.ARK_SPACE_MODEL || 'doubao-seed-2-0-pro-260215',

  // 移动云 MaaS Seedance 视频生成
  seedanceKey: process.env.SEEDANCE_API_KEY || process.env.SEEDANCE_KPI || process.env.MAAS_API_KEY || process.env.KPI || '',
  seedanceBaseUrl: process.env.SEEDANCE_BASE_URL || process.env.MAAS_BASE_URL || 'https://zhenze-huhehaote.cmecloud.cn/api/v3',
  seedanceModel: process.env.SEEDANCE_MODEL || process.env.MAAS_MODEL || 'doubao-seedance-2.0',
  seedancePython: process.env.SEEDANCE_PYTHON || process.env.PYTHON || 'python3',
  seedanceEnableVideoEncrypt: !['0', 'false', 'no'].includes(String(process.env.SEEDANCE_ENABLE_VIDEO_ENCRYPT || 'true').toLowerCase())
};
