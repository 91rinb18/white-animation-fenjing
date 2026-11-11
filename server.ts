import express from 'express';
import { GoogleGenAI, Type, ThinkingLevel } from '@google/genai';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  app.post('/api/process-script', async (req, res) => {
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    const stopHeartbeat = () => {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    };

    const sendJsonResponse = (statusCode: number, payload: string | object) => {
      stopHeartbeat();
      const bodyStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
      if (!res.headersSent) {
        res.status(statusCode).setHeader('Content-Type', 'application/json; charset=utf-8');
        res.send(bodyStr);
      } else {
        res.write(bodyStr);
        res.end();
      }
    };

    try {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        return sendJsonResponse(500, { error: 'GEMINI_API_KEY 未配置，请在系统设置中添加。' });
      }

      const { text, visualStylePrompt } = req.body;
      if (!text || !String(text).trim()) {
        return sendJsonResponse(400, { error: '请输入文案内容' });
      }

      const cleanText = String(text).trim();
      const stylePromptStr = String(visualStylePrompt || '').trim();

      const ai = new GoogleGenAI({
        apiKey,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          },
        },
      });

      const prompt = `
你是顶级短视频白板动画（16:9 1920x1080）视觉总监与分镜导演，专门为 geeklee/srt-whiteboard-animation 引擎编写分镜与提示词。

【核心法则一：原文 100% 逐句覆盖 + 白板黄金呼吸节奏】
1. 用户输入的原文文案，从第一句到最后一句必须 **100% 完整收录** 进各 Scene 各 Part 的 dialogues 数组中，严禁删减、概括或漏词。
2. 将所有自然段落按说话换气切分为 12~25 字的字幕单句，按顺序分配到各个 Scene 的 Part 中。
3. **单区域时长控制（防鬼畜、防死寂PPT）**：
   - 半屏区域（2-Part 模式的每个 Part）建议分配 **2~3 句台词（合计约 32~55 字，口播约 8~13 秒）**，以完美契合“边说边画 5~8 秒 + 定格消化 3~5 秒”的视觉节奏。
   - 全屏区域（1-Part 模式）建议分配 **3~4 句台词（合计约 50~75 字，口播约 12~18 秒）**，以契合“全屏运笔 8~12 秒 + 定格消化 4~6 秒”。
   - 严禁把超过 4 句或超过 75 字的长段台词塞进同一个 Part！长文案必须拆分出足够多的 Scene（例如 100~120 秒/400~480 字的文案应拆分为 6~8 幕、共 12~15 个绘制区），直到全文最后一句分配完毕。

【核心法则二：提炼具象化戏剧画面】
将抽象论述转化为具体、有戏剧张力的人物动作与场景意象（如：老工人在车间拉磨与身后管理层拿走利润对比、年轻员工放下工牌转身离开、办公桌堆积如山的免责公章与生锈齿轮、风暴中大船破裂众人跳船、极具张力的历史名场面等）。画面中的文字招牌必须标明汉字（如 with Chinese text "免责声明"）。

【核心法则三：画面构图铁律 —— 每个 Scene 仅限 1 或 2 个 Part，严禁 3 个及以上】
- **模式 A（2-Part 左右双分割构图，占大多数）**：
  * Part 1（左半区）: coordinates: [0, 0, 960, 1080]，mask 简明扼要（15字以内）
  * Part 2（右半区）: coordinates: [960, 0, 960, 1080]，mask 简明扼要（15字以内）
  * drawingPrompt 格式（简明精炼英文，30~50词即可，系统会自动追加画风后缀）：
    "A widescreen 16:9 2-panel split composition with two distinct halves side by side: [On the left half (Zone 1)]: <左半区画面>; [On the right half (Zone 2)]: <右半区画面>. Clean split composition, balanced spacing."
- **模式 B（1-Part 单幅全景构图）**：
  * Part 1（全屏）: coordinates: [0, 0, 1920, 1080]，mask 简明扼要（15字以内）
  * drawingPrompt 格式（简明精炼英文，25~45词即可）：
    "A widescreen 16:9 cinematic unified composition: <整幅画面主体细节与背景>. Cinematic wide perspective."
`;

      const modelsToTry: Array<{ name: string; thinkingConfig: Record<string, any> }> = [
        { name: 'gemini-2.5-flash', thinkingConfig: { thinkingBudget: 0 } },
        { name: 'gemini-3.6-flash', thinkingConfig: { thinkingBudget: 0 } },
        { name: 'gemini-3.5-flash', thinkingConfig: {} },
        { name: 'gemini-3.7-flash', thinkingConfig: { thinkingBudget: 0 } },
        { name: 'gemini-3.8-flash', thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } },
        { name: 'gemini-3.5-flash-lite', thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL } },
      ];

      let rawText = '';
      let lastFailureReason = '';
      let quotaRetrySeconds: number | null = null;

      const parseRetryDelay = (err: any): number | null => {
        try {
          const str = typeof err === 'string' ? err : (err?.message || JSON.stringify(err));
          const matchJson = str.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)\s*s?"/i);
          if (matchJson) return Math.ceil(parseFloat(matchJson[1]));
          const matchText = str.match(/retry in (\d+(?:\.\d+)?)\s*s/i);
          if (matchText) return Math.ceil(parseFloat(matchText[1]));
        } catch {}
        return null;
      };

      const isQuotaLimit = (err: any): boolean => {
        const str = typeof err === 'string' ? err : (err?.message || JSON.stringify(err || {}));
        return (
          str.includes('429') ||
          str.includes('RESOURCE_EXHAUSTED') ||
          str.includes('Quota exceeded') ||
          str.includes('quota')
        );
      };

      // Start sending lightweight whitespace heartbeats after 8s so proxy/gateway never drops long generations
      heartbeatTimer = setInterval(() => {
        if (!res.writableEnded) {
          if (!res.headersSent) {
            res.status(200).setHeader('Content-Type', 'application/json; charset=utf-8');
          }
          res.write(' ');
        }
      }, 8000);

      // Stream helper with fast first-chunk failover (14s) and active stream completion (up to 55s)
      const streamFromModel = async (modelName: string, thinkingConfig: Record<string, any>): Promise<string> => {
        const firstChunkTimeoutMs = 14000;
        const chunkIdleTimeoutMs = 16000;
        const maxTotalStreamMs = 55000;

        let timer: ReturnType<typeof setTimeout> | null = null;
        const clearTimer = () => {
          if (timer) {
            clearTimeout(timer);
            timer = null;
          }
        };

        const resetTimeout = (ms: number, label: string) =>
          new Promise<never>((_, reject) => {
            clearTimer();
            timer = setTimeout(() => reject(new Error(`${modelName} ${label}`)), ms);
          });

        const totalDeadline = Date.now() + maxTotalStreamMs;

        try {
          const streamPromise = ai.models.generateContentStream({
            model: modelName,
            contents: [
              {
                role: 'user',
                parts: [
                  {
                    text:
                      prompt +
                      '\n\n【画风基调】：\n' +
                      stylePromptStr +
                      '\n\n【原文内容（必须100%逐句收录进dialogues）】：\n' +
                      cleanText,
                  },
                ],
              },
            ],
            config: {
              maxOutputTokens: 65536,
              responseMimeType: 'application/json',
              thinkingConfig,
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  scenes: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        sceneId: { type: Type.INTEGER },
                        title: { type: Type.STRING },
                        drawingPrompt: { type: Type.STRING },
                        parts: {
                          type: Type.ARRAY,
                          items: {
                            type: Type.OBJECT,
                            properties: {
                              mask: { type: Type.STRING },
                              coordinates: {
                                type: Type.ARRAY,
                                items: { type: Type.INTEGER },
                              },
                              dialogues: {
                                type: Type.ARRAY,
                                items: { type: Type.STRING },
                              },
                            },
                            required: ['mask', 'coordinates', 'dialogues'],
                          },
                        },
                      },
                      required: ['sceneId', 'title', 'drawingPrompt', 'parts'],
                    },
                  },
                },
                required: ['scenes'],
              },
            },
          });

          const stream = await Promise.race([
            streamPromise,
            resetTimeout(firstChunkTimeoutMs, '连接响应超时'),
          ]);

          const iterator = stream[Symbol.asyncIterator]();
          let accumulated = '';
          let receivedFirstChunk = false;

          while (true) {
            const remainingTotal = totalDeadline - Date.now();
            if (remainingTotal <= 0) {
              throw new Error(`${modelName} 生成总时长超限`);
            }

            const waitMs = receivedFirstChunk
              ? Math.min(chunkIdleTimeoutMs, remainingTotal)
              : Math.min(firstChunkTimeoutMs, remainingTotal);

            const nextResult = await Promise.race([
              iterator.next(),
              resetTimeout(waitMs, receivedFirstChunk ? '数据流读取超时' : '首包响应超时'),
            ]);

            if (nextResult.done) break;

            const chunkText = nextResult.value?.text || '';
            if (chunkText) {
              receivedFirstChunk = true;
              accumulated += chunkText;
            }
          }

          clearTimer();
          return accumulated.trim();
        } finally {
          clearTimer();
        }
      };

      for (const candidate of modelsToTry) {
        if (req.destroyed) break;

        try {
          console.log(`[ScriptEngine] Requesting ${candidate.name} (input length: ${cleanText.length} chars)...`);
          const resultText = await streamFromModel(candidate.name, candidate.thinkingConfig);
          if (resultText) {
            rawText = resultText;
            console.log(`[ScriptEngine] ${candidate.name} completed (${rawText.length} chars).`);
            break;
          }
        } catch (err: any) {
          const reason = String(err?.message || err || 'unknown');
          console.log(`[ScriptEngine] Switching from ${candidate.name}: ${reason.slice(0, 120)}`);
          lastFailureReason = reason;

          if (isQuotaLimit(err)) {
            const delay = parseRetryDelay(err);
            if (delay) quotaRetrySeconds = delay;
          }
          await new Promise((r) => setTimeout(r, 400));
        }
      }

      if (!rawText) {
        let msg = '所有 AI 模型服务暂时繁忙，请稍后重试。';
        let isQuota = false;
        if (lastFailureReason) {
          if (isQuotaLimit(lastFailureReason) || quotaRetrySeconds) {
            isQuota = true;
            const waitTimeStr = quotaRetrySeconds
              ? `，请等待约 ${quotaRetrySeconds} 秒后再试`
              : '，请稍等 30-45 秒后再试';
            msg = `Google AI API 调用频次达到配额限制 (429 Too Many Requests)${waitTimeStr}，或在项目配置中升级/更换 API Key。`;
          } else if (lastFailureReason.includes('503') || lastFailureReason.includes('UNAVAILABLE')) {
            msg = 'Google AI 服务节点暂告繁忙 (503)，请稍等几秒后重试。';
          } else if (lastFailureReason.includes('超时') || lastFailureReason.includes('超限')) {
            msg = '生成耗时较长导致响应超时，请点击重试或分段贴入脚本。';
          }
        }
        return sendJsonResponse(isQuota ? 429 : 500, {
          error: `处理失败: ${msg}`,
          retrySeconds: quotaRetrySeconds || (isQuota ? 30 : null),
        });
      }

      return sendJsonResponse(200, rawText);
    } catch (error: any) {
      console.log('[ScriptEngine] Unhandled request exception:', error?.message || error);
      return sendJsonResponse(500, { error: `处理失败: ${error?.message || '未知错误'}` });
    }
  });

  if (process.env.NODE_ENV === 'production') {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  } else {
    const vite = await import('vite');
    const viteServer = await vite.createServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(viteServer.middlewares);
  }

  const PORT = 3000;
  app.listen(Number(PORT), '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
  });
}

startServer();
