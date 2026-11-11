import { useState, useEffect } from 'react';
import { Loader2, Copy, AlertTriangle, FileText, CheckCircle2, Info, Download, RefreshCw } from 'lucide-react';
import { jsonrepair } from 'jsonrepair';

const DEFAULT_TEXT = ``;

interface ScenePart {
  mask: string;
  coordinates: [number, number, number, number];
  dialogues: string[];
}

interface SceneData {
  sceneId: number;
  title?: string;
  drawingPrompt: string;
  parts: ScenePart[];
}

export default function App() {
  const [inputText, setInputText] = useState(DEFAULT_TEXT);
  const [loading, setLoading] = useState(false);
  const [scenes, setScenes] = useState<SceneData[] | null>(null);
  const [error, setError] = useState('');
  const [activeTab, setActiveTab] = useState<'srt' | 'prompts' | 'hermes'>('srt');
  const [copied, setCopied] = useState(false);
  const [promptsCopied, setPromptsCopied] = useState(false);
  const [hermesCopied, setHermesCopied] = useState(false);
  const [copiedSceneIdx, setCopiedSceneIdx] = useState<number | null>(null);
  const [copiedRawPromptIdx, setCopiedRawPromptIdx] = useState<number | null>(null);
  const [retryCountdown, setRetryCountdown] = useState<number | null>(null);

  // Settings
  const [charsPerSec, setCharsPerSec] = useState(4.0); // Default YouTube normal speed ~4.0
  const [visualStyle, setVisualStyle] = useState('notion');

  useEffect(() => {
    if (retryCountdown === null || retryCountdown <= 0) return;
    const timer = setInterval(() => {
      setRetryCountdown(prev => {
        if (prev === null || prev <= 1) {
          clearInterval(timer);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [retryCountdown]);

  const VISUAL_STYLES = [
    { 
      id: 'notion', 
      label: 'Notion极简风 (暖黄底+深灰线+红橙蓝点缀)', 
      prompt: 'Notion-style minimalist doodle, dark grey sketch lines, warm beige paper background (#F5EBD7), clean white space. Only use red, orange, or blue as sparse accent colors. Detailed graphic novel line-art, bold clear continuous outlines, minimal scattered fragments.',
      tip: '适合：杂文时评、哲学思考、日常叙事'
    },
    { 
      id: 'cad_drafting', 
      label: '青白工程图 (冰霜浅蓝灰底+深海工程蓝线+警示橙)', 
      prompt: 'Engineering schematic drafting style, crisp deep navy blue ink lines (#0F4C81), light ice-blue grey paper background (#F0F4F8), clean white margins. Only use warning orange (#F97316) for sparse highlight accents. High contrast continuous line art, NO dark background, NO chalk effect, minimal scattered fragments.',
      tip: '适合：硬核科普、科技解析、建筑/结构解读'
    },
    { 
      id: 'classic', 
      label: '经典手绘 (纯白底+纯黑线稿)', 
      prompt: 'Classic whiteboard animation style, pure black sketch lines, solid white background, minimalist line art, bold clean outlines, no fill colors, continuous strokes, no tiny scattered debris.',
      tip: '适合：通用简约、严肃文学（如《三体》）、历史复盘'
    },
    {
      id: 'serious_silhouette',
      label: '严肃纪实 (极简黑白剪影+高反差)',
      prompt: 'Minimalist high-contrast black and white silhouette art, bold clean outlines, NO cross-hatching, NO detailed shading, solid black focal shapes on white paper background. Serious, dark, and dramatic tone. Very clean vector-like line art, zero tiny scattered debris. Whiteboard animation compatible.',
      tip: '适合：卧底暗访、宏大叙事（用极简剪影和留白营造压抑/严肃感，完美契合白板引擎不出错）'
    },
    { 
      id: 'chalkboard', 
      label: '粉笔黑板 (墨绿底+粉笔白线)', 
      prompt: 'Chalkboard sketch style, chalky white continuous lines, dark green chalkboard background, educational doodle feel. Only use chalk yellow or pink as sparse accent colors. Bold clear outlines, minimal scattered fragments.',
      tip: '适合：教学演板、数学推导、知识盘点'
    }
  ];

  // 计算单个 Part 的口播时长、舒适运笔时长（50%~70%黄金占空比 + 物理画幅上下限）与定格留白时长
  const getPartTimingProfile = (part: ScenePart, totalPartsInScene: number) => {
    const validDialogues = (part.dialogues || []).map(d => d.trim()).filter(Boolean);
    const dialogueDurationsMs = validDialogues.map(trimmed =>
      Math.max(1200, Math.ceil((trimmed.length / charsPerSec) * 1000))
    );

    // 该区域内所有台词口播 + 句间自然换气 (200ms) 的总时长
    const speechSpanMs =
      dialogueDurationsMs.reduce((sum, d) => sum + d, 0) +
      Math.max(0, validDialogues.length - 1) * 200;

    // 判断是否为全屏大场面 (1920x1080) 还是半屏构图 (960x1080)
    const isFullScreen =
      totalPartsInScene === 1 || (Array.isArray(part.coordinates) && part.coordinates[2] >= 1400);

    // 黄金法则：
    // - 半屏 (960x1080)：舒适运笔区间 5.0s ~ 8.0s，理想占空比 ~65%
    // - 全屏 (1920x1080)：舒适运笔区间 8.0s ~ 12.0s，理想占空比 ~68%
    const minDrawMs = isFullScreen ? 8000 : 5000;
    const maxDrawMs = isFullScreen ? 12000 : 8000;
    const ratio = isFullScreen ? 0.68 : 0.65;

    const rawTargetDrawMs = Math.round(speechSpanMs * ratio);
    const drawDurationMs = Math.max(minDrawMs, Math.min(maxDrawMs, rawTargetDrawMs));

    // 确保“边说边画”结束后至少有 1.8s 的画面定格消化时间，避免画完秒切
    const minHoldMs = 1800;
    const effectivePartSpanMs = Math.max(speechSpanMs, drawDurationMs + minHoldMs);
    const holdDurationMs = effectivePartSpanMs - drawDurationMs;

    return {
      validDialogues,
      dialogueDurationsMs,
      speechSpanMs,
      drawDurationMs,
      holdDurationMs,
      effectivePartSpanMs,
      isFullScreen,
    };
  };

  const generateHermesMixed = () => {
    if (!scenes) return '';
    let mixed = '';
    let globalStartTimeMs = 0;

    scenes.forEach((scene, index) => {
      mixed += `========== 【第 ${index + 1} 幕】 ==========\n`;
      mixed += `[主图指令]:\n${scene.drawingPrompt}\n\n`;
      mixed += `[画面分割与剧情配合]:\n`;

      const totalParts = scene.parts?.length || 1;

      scene.parts?.forEach((part, pIdx) => {
        const profile = getPartTimingProfile(part, totalParts);
        const partStartMs = globalStartTimeMs;

        mixed += `--- 第 ${pIdx + 1} 部分 ---\n`;
        mixed += `绘制区域: ${part.mask}\n`;
        if (part.coordinates && part.coordinates.length === 4) {
          mixed += `精确坐标 (1920x1080): [x: ${part.coordinates[0]}, y: ${part.coordinates[1]}, w: ${part.coordinates[2]}, h: ${part.coordinates[3]}]\n`;
        }

        // 边说边画：台词一响起，画笔同步启动；画完后留出定格时间供观众消化画面与字幕
        const drawStartStr = formatSrtTime(partStartMs);
        const drawEndStr = formatSrtTime(partStartMs + profile.drawDurationMs);
        const drawSec = (profile.drawDurationMs / 1000).toFixed(1);
        const holdSec = (profile.holdDurationMs / 1000).toFixed(1);
        mixed += `(画笔绘制时间: ${drawStartStr} --> ${drawEndStr} | 边说边画 ${drawSec}s + 定格展示 ${holdSec}s)\n`;

        mixed += `配合剧情:\n`;
        let cursorMs = partStartMs;
        profile.validDialogues.forEach((dialogue, dIdx) => {
          const durationMs = profile.dialogueDurationsMs[dIdx];
          const startStr = formatSrtTime(cursorMs);
          const endStr = formatSrtTime(cursorMs + durationMs);
          mixed += `- [${startStr} --> ${endStr}] ${dialogue}\n`;
          cursorMs += durationMs + 200; // 句间自然换气
        });

        // 推进到本 Part 完整结束（取口播结束与“运笔+保底定格”中的较大值）+ 区域间换气 300ms
        globalStartTimeMs = partStartMs + profile.effectivePartSpanMs + 300;
        mixed += `\n`;
      });

      globalStartTimeMs += 500; // 幕间自然停顿
    });

    return mixed.trim();
  };

  const copyHermesMixed = () => {
    const text = generateHermesMixed();
    if (text) {
      navigator.clipboard.writeText(text);
      setHermesCopied(true);
      setTimeout(() => setHermesCopied(false), 2000);
    }
  };

  const handleProcess = async () => {
    setLoading(true);
    setError('');
    setScenes(null);
    setRetryCountdown(null);

    const fetchWithRetry = async (url: string, options: RequestInit, retries = 1): Promise<Response> => {
      try {
        return await fetch(url, options);
      } catch (err: any) {
        if (retries > 0 && err?.name === 'TypeError' && String(err?.message || '').toLowerCase().includes('fetch')) {
          await new Promise(r => setTimeout(r, 1200));
          return fetchWithRetry(url, options, retries - 1);
        }
        throw err;
      }
    };

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 85000);

      let res: Response;
      try {
        res = await fetchWithRetry('/api/process-script', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            text: inputText,
            visualStylePrompt: VISUAL_STYLES.find(s => s.id === visualStyle)?.prompt 
          }),
          signal: controller.signal
        });
      } finally {
        clearTimeout(timeoutId);
      }
      
      let textResponse = '';
      if (!res.ok) {
        textResponse = await res.text();
        let errorMsg = '生成失败';
        try {
          const errData = JSON.parse(textResponse.trim());
          errorMsg = errData.error || errorMsg;
          if (errData.retrySeconds && typeof errData.retrySeconds === 'number') {
            setRetryCountdown(errData.retrySeconds);
          }
        } catch (e) {
          errorMsg = `服务器响应异常 (${res.status}): ${textResponse.trim().slice(0, 100)}`;
        }
        throw new Error(errorMsg);
      }

      textResponse = await res.text();

      let data: any;
      try {
        let cleaned = textResponse.trim();
        const jsonBlockMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        if (jsonBlockMatch) {
          cleaned = jsonBlockMatch[1].trim();
        } else {
          const firstBrace = cleaned.indexOf('{');
          const firstBracket = cleaned.indexOf('[');
          let startIdx = -1;
          if (firstBrace !== -1 && firstBracket !== -1) {
            startIdx = Math.min(firstBrace, firstBracket);
          } else if (firstBrace !== -1) {
            startIdx = firstBrace;
          } else if (firstBracket !== -1) {
            startIdx = firstBracket;
          }
          if (startIdx !== -1) {
            cleaned = cleaned.slice(startIdx);
          }
        }

        try {
          data = JSON.parse(cleaned);
        } catch (initialErr) {
          // Attempt automatic JSON repair (handles unescaped characters, missing quotes/brackets, trailing commas)
          const repaired = jsonrepair(cleaned);
          data = JSON.parse(repaired);
        }
      } catch (e) {
        throw new Error(`服务器返回数据解析失败，请点击重试。\n响应摘要: ${textResponse.trim().slice(0, 120)}...`);
      }

      if (data && typeof data === 'object' && !Array.isArray(data) && data.error) {
        if (data.retrySeconds && typeof data.retrySeconds === 'number') {
          setRetryCountdown(data.retrySeconds);
        }
        throw new Error(String(data.error));
      }

      let rawScenes: any[] = [];
      if (Array.isArray(data)) {
        rawScenes = data;
      } else if (data && Array.isArray(data.scenes)) {
        rawScenes = data.scenes;
      } else if (data && Array.isArray(data.storyboard)) {
        rawScenes = data.storyboard;
      } else if (data && Array.isArray(data.data)) {
        rawScenes = data.data;
      } else if (data?.data && Array.isArray(data.data.scenes)) {
        rawScenes = data.data.scenes;
      } else if (data && typeof data === 'object') {
        for (const key of Object.keys(data)) {
          if (Array.isArray(data[key]) && data[key].length > 0) {
            const first = data[key][0];
            if (first && (first.drawingPrompt || first.parts || first.sceneId || first.dialogues)) {
              rawScenes = data[key];
              break;
            }
          }
        }
      }

      if (!rawScenes || rawScenes.length === 0) {
        throw new Error('AI 返回数据缺少有效的分镜场景列表，请尝试重新生成。');
      }

      const selectedStyle = VISUAL_STYLES.find(s => s.id === visualStyle);
      const styleSuffix = selectedStyle ? selectedStyle.prompt : '';
      
      const normalizedScenes: SceneData[] = rawScenes.map((s: any, idx: number) => {
        let prompt = (s.drawingPrompt || s.prompt || s.drawing_prompt || '').trim();
        if (styleSuffix && !prompt.toLowerCase().includes(styleSuffix.slice(0, 20).toLowerCase())) {
          prompt = `${prompt.replace(/\.+$/, '')}. ${styleSuffix}`;
        }

        let parts: ScenePart[] = [];
        if (Array.isArray(s.parts)) {
          const totalParts = s.parts.length;
          parts = s.parts.slice(0, 2).map((p: any, pIdx: number) => {
            const defaultCoords: [number, number, number, number] =
              totalParts === 1
                ? [0, 0, 1920, 1080]
                : pIdx === 0
                ? [0, 0, 960, 1080]
                : [960, 0, 960, 1080];
            
            const rawDialogues = p.dialogues || p.dialogue || p.lines || p.subtitles || [];
            const dialoguesList = Array.isArray(rawDialogues) 
              ? rawDialogues.map(d => String(d)) 
              : typeof rawDialogues === 'string' 
              ? [rawDialogues] 
              : [];

            return {
              mask: p.mask || p.maskPrompt || p.area || `区域 ${pIdx + 1}`,
              coordinates: (Array.isArray(p.coordinates) && p.coordinates.length === 4) 
                ? p.coordinates 
                : defaultCoords,
              dialogues: dialoguesList
            };
          });
        }

        return {
          sceneId: typeof s.sceneId === 'number' ? s.sceneId : (idx + 1),
          title: s.title || `第 ${idx + 1} 幕`,
          drawingPrompt: prompt,
          parts: parts
        };
      });
      
      setScenes(normalizedScenes);
      setActiveTab('srt');
    } catch (err: any) {
      if (err.name === 'AbortError') {
        setError('请求超时（超过 85 秒），可能服务器节点繁忙，请点击重试。');
      } else if (err.name === 'TypeError' && String(err.message || '').toLowerCase().includes('fetch')) {
        setError('服务器连接正在建立或网络短暂波动，请点击“立即重试”。');
      } else {
        setError(err.message || '生成失败，请稍后重试。');
      }
    } finally {
      setLoading(false);
    }
  };

  const generateContinuousSRT = () => {
    if (!scenes) return '';
    let srt = '';
    let index = 1;
    let globalStartTimeMs = 0;

    scenes.forEach((scene) => {
      const totalParts = scene.parts?.length || 1;
      scene.parts?.forEach((part) => {
        const profile = getPartTimingProfile(part, totalParts);
        const partStartMs = globalStartTimeMs;
        let cursorMs = partStartMs;

        profile.validDialogues.forEach((trimmed, dIdx) => {
          const durationMs = profile.dialogueDurationsMs[dIdx];
          const startStr = formatSrtTime(cursorMs);
          const endStr = formatSrtTime(cursorMs + durationMs);

          srt += `${index++}\n`;
          srt += `${startStr} --> ${endStr}\n`;
          srt += `${trimmed}\n\n`;

          cursorMs += durationMs + 200; // 句间自然换气间隔
        });

        // 与 Hermes 混合版保持毫秒级严丝合缝同步
        globalStartTimeMs = partStartMs + profile.effectivePartSpanMs + 300;
      });
      
      globalStartTimeMs += 500; // 幕间自然停顿
    });

    return srt.trim();
  };

  const formatSrtTime = (ms: number) => {
    const hours = Math.floor(ms / 3600000);
    const minutes = Math.floor((ms % 3600000) / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    const milliseconds = ms % 1000;
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')},${milliseconds.toString().padStart(3, '0')}`;
  };

  const copyToClipboard = () => {
    const srt = generateContinuousSRT();
    if (srt) {
      navigator.clipboard.writeText(srt);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const downloadSrt = () => {
    const srt = generateContinuousSRT();
    if (!srt) return;
    const blob = new Blob([srt], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `whiteboard_script_${Date.now()}.srt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const formatScenePromptWithCoordinates = (scene: SceneData, index: number) => {
    let text = `========================================\n`;
    text += `【场景 ${index + 1} - ${scene.title || '未命名场景'}】\n\n`;
    text += `[作图提示词 (送入生图 AI / Midjourney / Flux)]:\n${scene.drawingPrompt}\n\n`;
    text += `[白板引擎 Mask 划区与精确坐标 (1920x1080)]:\n`;
    const totalParts = scene.parts?.length || 1;
    scene.parts?.forEach((part, idx) => {
      const profile = getPartTimingProfile(part, totalParts);
      const drawSec = (profile.drawDurationMs / 1000).toFixed(1);
      const holdSec = (profile.holdDurationMs / 1000).toFixed(1);
      const coords = part.coordinates && part.coordinates.length === 4 
        ? `[x: ${part.coordinates[0]}, y: ${part.coordinates[1]}, w: ${part.coordinates[2]}, h: ${part.coordinates[3]}]` 
        : '[坐标待定]';
      text += `  • Part ${idx + 1}: ${part.mask}  => 坐标: ${coords} | 运笔: ${drawSec}s + 定格: ${holdSec}s\n`;
    });
    text += `========================================\n`;
    return text;
  };

  const copyAllPrompts = () => {
    if (!scenes) return;
    const allPrompts = scenes.map((s, i) => formatScenePromptWithCoordinates(s, i)).join('\n========================================\n\n');
    navigator.clipboard.writeText(allPrompts);
    setPromptsCopied(true);
    setTimeout(() => setPromptsCopied(false), 2000);
  };

  const copySingleScenePrompt = (scene: SceneData, index: number) => {
    const text = formatScenePromptWithCoordinates(scene, index);
    navigator.clipboard.writeText(text);
    setCopiedSceneIdx(index);
    setTimeout(() => setCopiedSceneIdx(null), 2000);
  };

  const copyRawPromptOnly = (rawPrompt: string, index: number) => {
    navigator.clipboard.writeText(rawPrompt);
    setCopiedRawPromptIdx(index);
    setTimeout(() => setCopiedRawPromptIdx(null), 2000);
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans">
      <div className="max-w-[1400px] mx-auto p-4 lg:p-8">
        
        <header className="mb-8 flex flex-col gap-2 border-b border-slate-200 pb-6">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-indigo-600 flex items-center justify-center text-white shadow-sm">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"></path></svg>
            </div>
            <h1 className="text-2xl font-bold tracking-tight">白板SRT动画 v3</h1>
          </div>
          <p className="text-slate-500 text-sm">Geeklee srt-whiteboard-animation 专属：支持极简、写实、硬核科普的智能分镜与精确坐标指引体系。</p>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          
          {/* 左侧控制台 */}
          <div className="lg:col-span-5 flex flex-col gap-6">
            
            <section className="bg-white rounded-2xl shadow-sm border border-slate-200 p-5">
              <h2 className="font-medium flex items-center gap-2 mb-4">
                <FileText className="w-4 h-4 text-slate-400" />
                文案输入
              </h2>
              <textarea
                className="w-full h-[320px] p-4 text-[15px] leading-relaxed text-slate-700 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all resize-none"
                placeholder="贴入你的文章（如《三体》片段、精神病院暗访、深度时评等）。\nAI 会自动保持原汁原味，并精确拆分 16:9 画面的构图坐标..."
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
              />
            </section>

            <section className="bg-white rounded-2xl shadow-sm border border-slate-200 p-5 space-y-6">
              
              {/* 画风选择 */}
              <div>
                <label className="block text-sm font-medium mb-3">强制视觉风格 (Visual Style)</label>
                <div className="space-y-2">
                  {VISUAL_STYLES.map(style => (
                    <label key={style.id} className={`flex flex-col p-3 border rounded-xl cursor-pointer transition-colors ${visualStyle === style.id ? 'border-indigo-500 bg-indigo-50/50' : 'border-slate-200 hover:bg-slate-50'}`}>
                      <div className="flex items-center gap-3">
                        <input 
                          type="radio" 
                          name="visualStyle" 
                          value={style.id}
                          checked={visualStyle === style.id}
                          onChange={(e) => setVisualStyle(e.target.value)}
                          className="w-4 h-4 text-indigo-600 focus:ring-indigo-500 border-gray-300"
                        />
                        <span className={`text-sm font-medium ${visualStyle === style.id ? 'text-indigo-900' : 'text-slate-700'}`}>{style.label}</span>
                      </div>
                      <span className="text-xs text-slate-500 ml-7 mt-1">{style.tip}</span>
                    </label>
                  ))}
                </div>
              </div>

              {/* 语速控制 */}
              <div>
                <div className="flex justify-between items-center mb-2">
                  <label className="text-sm font-medium">口播语速评估</label>
                  <span className="text-xs font-mono bg-slate-100 px-2 py-1 rounded text-slate-600">{charsPerSec.toFixed(1)} 字/秒 (油管默认)</span>
                </div>
                <input 
                  type="range" 
                  min="2.0" 
                  max="6.0" 
                  step="0.1" 
                  value={charsPerSec}
                  onChange={(e) => setCharsPerSec(Number(e.target.value))}
                  className="w-full accent-indigo-600"
                />
              </div>
              
              <button
                onClick={handleProcess}
                disabled={loading || !inputText.trim()}
                className="w-full flex items-center justify-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white font-medium py-3.5 px-4 rounded-xl transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
              >
                {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : '智能拆分分镜与坐标生成'}
              </button>
            </section>
          </div>

          {/* 右侧结果区 */}
          <div className="lg:col-span-7 flex flex-col bg-slate-50/50 rounded-2xl shadow-sm border border-slate-200 overflow-hidden min-h-[600px]">
            
            <div className="flex border-b border-slate-200 bg-white p-2 gap-2">
              {[
                { id: 'srt', label: '① 白板时间轴 (SRT)' },
                { id: 'prompts', label: '② AI作图指令 (Midjourney)' },
                { id: 'hermes', label: '③ Hermes混合版 (机器人专用)' }
              ].map(tab => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id as any)}
                  className={`flex-1 py-2.5 px-3 rounded-lg text-sm font-medium transition-all ${activeTab === tab.id ? 'bg-white text-indigo-600 shadow-sm border border-slate-200' : 'text-slate-500 hover:text-slate-700 hover:bg-slate-100'}`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            <div className="p-6 flex-1 bg-[#F8FAFC] overflow-auto relative">
              {error && (
                <div className="mb-6 p-4 bg-amber-50 border border-amber-200 rounded-xl text-amber-900 text-sm flex flex-col sm:flex-row sm:items-center justify-between gap-3 shadow-sm">
                  <div className="flex items-start gap-3">
                    <AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
                    <div>
                      <div className="flex items-center gap-2 mb-0.5">
                        <p className="font-medium text-amber-950">请求提示</p>
                        {retryCountdown !== null && retryCountdown > 0 && (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-200/80 text-amber-900">
                            倒计时 {retryCountdown}s
                          </span>
                        )}
                        {retryCountdown === 0 && (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-800">
                            配额已恢复，可点击重试
                          </span>
                        )}
                      </div>
                      <p className="text-amber-800 leading-relaxed">{error}</p>
                    </div>
                  </div>
                  <button
                    onClick={handleProcess}
                    disabled={loading || (retryCountdown !== null && retryCountdown > 0)}
                    className={`self-end sm:self-auto px-4 py-2 rounded-lg font-medium text-xs shadow-sm transition-all flex items-center gap-1.5 whitespace-nowrap cursor-pointer ${
                      retryCountdown !== null && retryCountdown > 0
                        ? 'bg-slate-200 text-slate-400 cursor-not-allowed border border-slate-300'
                        : 'bg-amber-600 hover:bg-amber-700 text-white active:scale-95'
                    }`}
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
                    {retryCountdown !== null && retryCountdown > 0 ? `${retryCountdown} 秒后重试` : '立即重试'}
                  </button>
                </div>
              )}

              {loading && (
                <div className="absolute inset-0 flex flex-col items-center justify-center text-indigo-500 bg-white/80 backdrop-blur-sm z-10">
                  <Loader2 className="w-8 h-8 animate-spin mb-3" />
                  <p className="text-sm font-medium">引擎正在深度构建 16:9 坐标系分镜，请稍候...</p>
                </div>
              )}

              {!scenes && !loading && !error && (
                <div className="h-full flex flex-col items-center justify-center text-slate-400">
                  <Info className="w-12 h-12 mb-3 text-slate-300" />
                  <p className="text-sm">支持极其复杂的写实叙事与严肃科普<br/>左侧输入文案即可启动</p>
                </div>
              )}

              {scenes && !loading && activeTab === 'srt' && (
                <div className="h-full flex flex-col animate-in fade-in">
                  <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2 mb-3">
                    <p className="text-xs text-slate-500">纯净标准 SRT 字幕（无多余标签乱码，完美兼容各类小程序、剪映、CapCut 与 TTS 朗读）。</p>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={copyToClipboard}
                        className="flex items-center gap-1.5 text-xs font-semibold text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 px-3 py-1.5 rounded-lg transition-colors shadow-sm"
                      >
                        {copied ? <CheckCircle2 className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4" />}
                        {copied ? '已复制SRT' : '复制标准SRT'}
                      </button>
                      <button
                        onClick={downloadSrt}
                        className="flex items-center gap-1.5 text-xs font-semibold text-indigo-700 bg-indigo-50 border border-indigo-200 hover:bg-indigo-100 px-3 py-1.5 rounded-lg transition-colors shadow-sm"
                        title="下载为 .srt 文件"
                      >
                        <Download className="w-4 h-4 text-indigo-600" />
                        下载 .srt
                      </button>
                    </div>
                  </div>
                  <textarea
                    readOnly
                    value={generateContinuousSRT()}
                    className="flex-1 w-full p-4 text-[13px] font-mono text-slate-700 bg-white border border-slate-200 rounded-xl resize-none focus:outline-none shadow-sm min-h-[420px]"
                  />
                </div>
              )}

              {scenes && !loading && activeTab === 'prompts' && (
                <div className="space-y-6 animate-in fade-in pb-8">
                  <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
                    <div className="bg-blue-50/50 p-4 rounded-xl border border-blue-100 text-sm text-blue-800 flex-1">
                      <strong className="block mb-1 font-semibold">16:9 画布坐标与 Midjourney 作图提示词：</strong>
                      每个场景均配备对应区域的精确像素坐标 [x, y, w, h] 与英文线稿出图指令，支持单独复制或一键批量导出。
                    </div>
                    <button
                      onClick={copyAllPrompts}
                      className="flex items-center gap-1.5 text-xs font-bold text-indigo-700 bg-indigo-50 border border-indigo-200 hover:bg-indigo-100 px-4 py-2.5 rounded-lg transition-colors shadow-sm whitespace-nowrap"
                    >
                      {promptsCopied ? <CheckCircle2 className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4" />}
                      {promptsCopied ? '已复制全部指令与坐标' : '一键提取全部作图指令与坐标'}
                    </button>
                  </div>
                  
                  {scenes.map((scene, i) => (
                    <div key={scene.sceneId || i} className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm space-y-4">
                      <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                        <div className="flex items-center gap-3">
                          <span className="bg-indigo-100 text-indigo-700 text-xs font-bold px-2.5 py-1 rounded-md">
                            场景 {i + 1}
                          </span>
                          <span className="text-sm font-semibold text-slate-800">{scene.title}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => copyRawPromptOnly(scene.drawingPrompt, i)}
                            className="flex items-center gap-1 text-xs font-medium text-slate-600 bg-slate-100 hover:bg-slate-200 px-2.5 py-1.5 rounded-md transition-colors"
                            title="仅复制纯英文作图提示词"
                          >
                            {copiedRawPromptIdx === i ? <CheckCircle2 className="w-3.5 h-3.5 text-green-600" /> : <Copy className="w-3.5 h-3.5" />}
                            {copiedRawPromptIdx === i ? '已复制Prompt' : '仅复制Prompt'}
                          </button>
                          <button
                            onClick={() => copySingleScenePrompt(scene, i)}
                            className="flex items-center gap-1 text-xs font-medium text-indigo-700 bg-indigo-50 border border-indigo-200 hover:bg-indigo-100 px-2.5 py-1.5 rounded-md transition-colors"
                            title="复制包含本场景作图指令与精确坐标的完整说明"
                          >
                            {copiedSceneIdx === i ? <CheckCircle2 className="w-3.5 h-3.5 text-green-600" /> : <Copy className="w-3.5 h-3.5" />}
                            {copiedSceneIdx === i ? '已复制全部信息' : '复制本幕指令+坐标'}
                          </button>
                        </div>
                      </div>
                      
                      <div className="space-y-4">
                        <div>
                          <label className="block text-xs font-bold tracking-wider text-slate-400 mb-2">英文作图指令 (送入 Midjourney / DALL-E)</label>
                          <div className="bg-slate-50 p-4 rounded-lg text-sm text-slate-700 font-mono leading-relaxed select-all border border-slate-100">
                            {scene.drawingPrompt}
                          </div>
                        </div>
                        
                        <div>
                          <label className="block text-xs font-bold tracking-wider text-slate-400 mb-2">白板引擎 Mask 划区与精确坐标 (1920x1080)</label>
                          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2.5">
                            {scene.parts?.map((part, idx) => {
                              const profile = getPartTimingProfile(part, scene.parts?.length || 1);
                              const drawSec = (profile.drawDurationMs / 1000).toFixed(1);
                              const holdSec = (profile.holdDurationMs / 1000).toFixed(1);
                              return (
                                <div key={idx} className="bg-slate-50 border border-slate-200/80 rounded-lg p-3 text-xs flex flex-col justify-between gap-1.5">
                                  <div className="flex items-start gap-1.5">
                                    <span className="bg-indigo-600 text-white font-bold text-[10px] px-1.5 py-0.5 rounded flex-shrink-0">
                                      Part {idx + 1}
                                    </span>
                                    <span className="font-medium text-slate-700 leading-tight">{part.mask}</span>
                                  </div>
                                  <div className="flex flex-wrap items-center gap-1.5">
                                    {part.coordinates && part.coordinates.length === 4 ? (
                                      <div className="text-[11px] text-indigo-600 font-mono font-semibold bg-indigo-50/80 border border-indigo-100 px-2 py-1 rounded">
                                        坐标: [{part.coordinates.join(', ')}]
                                      </div>
                                    ) : (
                                      <div className="text-[11px] text-slate-400 font-mono bg-slate-100 px-2 py-1 rounded">
                                        坐标: 未指定
                                      </div>
                                    )}
                                    <div className="text-[11px] text-emerald-700 font-mono font-medium bg-emerald-50 border border-emerald-200/80 px-2 py-1 rounded">
                                      运笔 {drawSec}s + 定格 {holdSec}s
                                    </div>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {scenes && !loading && activeTab === 'hermes' && (
                <div className="h-full flex flex-col animate-in fade-in pb-8">
                  <div className="flex justify-between items-center mb-3">
                    <p className="text-sm text-slate-500 font-medium">将此内容一键复制给 Hermes 机器人，它会自动帮您生成底图并绑定字幕时间轴。</p>
                    <button
                      onClick={copyHermesMixed}
                      className="flex items-center gap-1.5 text-xs font-bold text-white bg-indigo-600 border border-indigo-700 hover:bg-indigo-700 px-4 py-2 rounded-lg transition-colors shadow-sm"
                    >
                      {hermesCopied ? <CheckCircle2 className="w-4 h-4 text-white" /> : <Copy className="w-4 h-4" />}
                      {hermesCopied ? '已复制' : '一键复制发给机器人'}
                    </button>
                  </div>
                  <textarea
                    readOnly
                    value={generateHermesMixed()}
                    className="flex-1 w-full p-4 text-[13px] font-mono text-slate-700 bg-white border border-slate-200 rounded-xl resize-none focus:outline-none shadow-sm min-h-[400px]"
                  />
                </div>
              )}

            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
