# 14 种经典 UI/UX 风格 · 参考卡

> 来源：`14种经典的UI7643265836094565000-copy.docx` 里嵌入的 22 个 HTML 示例（OLE 嵌入对象，已全部提取到本目录）。
> 每个示例都是一套完整的 UI 组件展示页：**按钮 / 输入框 / 开关 / 播放器 / 进度 / 标签 / 调色板 / 卡片**，
> 外加「浅色 / 深色」两版（文件名带 `-light` 的是浅色版）。
> 看效果：`node test/tool_ui_server.js` 然后开 `http://127.0.0.1:8232/`。

---

## Acid Graphics

**文件**：`acid-graphics-components-light.html`　**标题**：Acid Graphics · 酸性设计组件（浅色版）

> 浅色酸性——高饱和色块 + 偏移阴影 + 锐利直角，保留迷幻力量感，去掉霓虹光晕。

**配色变量**

```css
--bg: #F2F0EB;
--bg-card: #FAFAF7;
--text: #1A1A1A;
--text-light: #666666;
--accent: #22C55E;
--magenta: #D946EF;
--yellow: #EAB308;
--cyan: #06B6D4;
--orange: #F97316;
--border: #D4D0C8;
```

| 项 | 值 |
|---|---|
| 圆角 | 无（直角） |
| 渐变 | `linear-gradient( 0deg, transparent, transparent 2px, rgba(0,0,0,0.5)`  `linear-gradient(90deg, var(--accent)` |
| 阴影 | `3px 3px 0 var(--text)`  `1px 1px 0 var(--text)`  `3px 3px 0 var(--accent)` |
| 字体 | `var(--font-mono)` / `var(--font-display)` |

## Acid Graphics

**文件**：`acid-graphics-components.html`　**标题**：Acid Graphics · 酸性设计组件

> 灵感源自迷幻视觉，高饱和度霓虹色、液态金属感与扫描线效果。

**配色变量**

```css
--bg: #0D0D0D;
--panel-bg: rgba(10, 10, 10, 0.92);
--text: #00FF00;
--text-light: #66FF66;
--accent: #39FF14;
--magenta: #FF00FF;
--yellow: #FFFF00;
--cyan: #00FFFF;
--orange: #FF4500;
--panel-border: rgba(57, 255, 20, 0.4);
--glow-green: 0 0 12px rgba(57, 255, 20, 0.5), 0 0 30px rgba(57, 255, 20, 0.2);
--glow-magenta: 0 0 12px rgba(255, 0, 255, 0.5), 0 0 30px rgba(255, 0, 255, 0.2);
```

| 项 | 值 |
|---|---|
| 圆角 | 1px |
| 渐变 | `linear-gradient( 0deg, transparent, transparent 2px, rgba(0,255,0,0.3)`  `linear-gradient(90deg, var(--accent)` |
| 阴影 | `0 0 20px rgba(57,255,20,0.15),`  `0 0 8px rgba(57,255,20,0.4)`  `0 0 4px rgba(57,255,20,0.5)` |
| 字体 | `var(--font-mono)` / `var(--font-display)` |

## Anti-Design

**文件**：`anti-design-components-lite.html`　**标题**：Anti-Design Lite 温和反设计 — 组件展示

> 以混乱、不和谐、朋克风的方式，挑战传统的美学和可用性规则。

**配色变量**

```css
--bg: #F8F5F0;
--text: #1A1A1A;
--text-light: #888888;
--accent: #E8364E;
--blue: #2D5BFF;
--green: #22C55E;
--yellow: #FACC15;
--border: #E0DCD5;
```

| 项 | 值 |
|---|---|
| 圆角 | 0 50% 0 50% / 12px 4px 12px 4px / 50% 2px 50% 2px / 50% 0 50% 0 |
| 渐变 | `linear-gradient( 90deg, var(--accent)` |
| 阴影 | `6px 6px 0 var(--accent), -3px -3px 0 var(--blue)`  `3px 3px 0 var(--accent)`  `4px 4px 0 var(--yellow)` |
| 字体 | `'Space Mono', monospace` / `'Outfit', sans-serif` |

## Anti-Design Components

**文件**：`anti-design-components.html`　**标题**：Anti-Design Components

> 以混乱、不和谐、朋克风的方式，挑战传统的美学和可用性规则。

| 项 | 值 |
|---|---|
| 圆角 | 0 30px 0 30px / 100px 0 100px 0 / 50px / 11px 3px 11px 3px / 50% 0 50% 0 |
| 渐变 | `linear-gradient( 90deg, #FF0000 0px, #FF0000 8px, #00FF00 8px, #00FF00 16px, #0000FF 16px, #0000FF 24px, #FF00FF 24px, #FF00FF 32px, #FFFF00 32px, #FFFF00 40px )`  `linear-gradient( 45deg, transparent, transparent 2px, rgba(255,0,0,0.03)` |
| 阴影 | `12px 12px 0 #00FF00, -8px -8px 0 #0000FF`  `4px 4px 0 #FF0000`  `6px 6px 0 #FFFF00, -3px -3px 0 #FF00FF` |
| 字体 | `'Space Mono', monospace` / `'Bangers', cursive` |

## Bauhaus

**文件**：`bauhaus-components.html`　**标题**：包豪斯 (Bauhaus) 组件展示

> 强调形式服务于功能，喜欢使用基础的几何形状（圆形、方形、三角形）和红、黄、蓝三原色。

**配色变量**

```css
--bg: #F0EAD6;
--text: #1A1A1A;
--text-light: #666666;
--red: #E30613;
--yellow: #FFD100;
--blue: #0033A0;
```

| 项 | 值 |
|---|---|
| 圆角 | 2px / 50% |
| 阴影 | `0 20px 60px rgba(0,0,0,0.3)`  `3px 3px 0 var(--black)` |
| 字体 | `'Inter', 'Noto Sans SC', sans-serif` / `inherit` |

## Brutalism 粗野主义 — 组件展示

**文件**：`brutalism-components.html`　**标题**：Brutalism 粗野主义 — 组件展示

> 新粗野主义的前身，完全放弃装饰、结构外露，用纯粹功能性的元素直接呈现。

| 项 | 值 |
|---|---|
| 圆角 | 无（直角） |
| 字体 | `'Courier New', Courier, monospace` / `'Courier New',monospace` |

## Claymorphism

**文件**：`claymorphism-components.html`　**标题**：Claymorphism (粘土拟态) 组件展示

> 相比新拟态，它更像是Q版的3D风格：使用明亮的色彩、圆润的边角和厚实的阴影，如同玩具一般可爱。

**配色变量**

```css
--bg: #F0F4FF;
--text: #3D3D5C;
--text-light: #8E8EA0;
--accent: #A78BFA;
```

| 项 | 值 |
|---|---|
| 圆角 | 2px / 24px / 999px / 20px / 14px |
| 阴影 | `0 20px 60px rgba(0,0,0,0.3)`  `4px 6px 0 var(--shadow)`  `4px 6px 0 rgba(0,0,0,0.15)` |
| 字体 | `'Inter', 'Noto Sans SC', sans-serif` / `inherit` |

## Flat Design

**文件**：`flat-design-components.html`　**标题**：Flat Design (扁平化) 组件展示

> 作为对拟物化的"反叛"，其特点是简洁、二维、无阴影和纹理，强调内容本身。

**配色变量**

```css
--bg: #FFFFFF;
--text: #2C3E50;
--text-light: #95A5A6;
--accent: #3498DB;
--border: #D5DCE6;
--swatch-1: #3498DB;
--swatch-2: #E74C3C;
--swatch-3: #2ECC71;
--swatch-4: #F39C12;
--swatch-5: #9B59B6;
```

| 项 | 值 |
|---|---|
| 圆角 | 2px / 4px / 3px / 4px 4px 0 0 |
| 字体 | `'Inter', 'Noto Sans SC', sans-serif` / `inherit` |

## Glassmorphism

**文件**：`glassmorphism-components-light.html`　**标题**：Glassmorphism 玻璃拟态 · 浅色版

> 浅色玻璃拟态——柔和的薰衣草渐变背景搭配白色半透明毛玻璃，保留通透层次感。

**配色变量**

```css
--text: #2D2B55;
--text-light: rgba(45,43,85,0.55);
--accent: #667eea;
--glass-border: rgba(255, 255, 255, 0.65);
```

| 项 | 值 |
|---|---|
| 圆角 | 50% / 2px / 16px / 14px / 999px |
| 渐变 | `linear-gradient(135deg, #E8E0F0 0%, #D4E4F7 30%, #C8E6F5 60%, #E0D8F0 100%)`  `linear-gradient(135deg, #DDD5EC 0%, #C5D8F0 35%, #BDD9F2 65%, #D5CDE8 100%)` |
| 阴影 | `0 20px 60px rgba(45,43,85,0.1)`  `0 4px 16px var(--glass-shadow)`  `0 6px 20px rgba(45,43,85,0.12)` |
| 毛玻璃 | `blur(16px) / blur(10px)` |
| 字体 | `'Inter', 'Noto Sans SC', sans-serif` / `inherit` |

## Glassmorphism

**文件**：`glassmorphism-components.html`　**标题**：Glassmorphism 玻璃拟态组件展示

> 模拟磨砂玻璃的质感，通过透明度和背景模糊创建层次感鲜明的毛玻璃效果。

**配色变量**

```css
--bg: linear-gradient(135deg, #667eea, #764ba2);
--text: #FFFFFF;
--text-light: rgba(255,255,255,0.7);
--accent: #FFFFFF;
--glass-border: rgba(255,255,255,0.25);
```

| 项 | 值 |
|---|---|
| 圆角 | 14px / 999px / 50% / 12px / 2px |
| 渐变 | `linear-gradient(135deg, #667eea, #764ba2)` |
| 阴影 | `0 20px 60px rgba(0,0,0,0.3)`  `0 2px 8px rgba(0,0,0,0.15)` |
| 毛玻璃 | `blur(10px)` |
| 字体 | `'Inter', 'Noto Sans SC', sans-serif` / `inherit` |

## Liquid Glass

**文件**：`liquid-glass-components-light.html`　**标题**：Liquid Glass - 液态玻璃组件展示（浅色版）

> 浅色液态玻璃——在柔和背景上保留毛玻璃模糊与光线折射动画，如同透过磨砂窗纱。

**配色变量**

```css
--bg: #F0EFF5;
--bg-glass: rgba(255, 255, 255, 0.55);
--text: #1E1B3A;
--text-light: #7C7893;
--accent: #6366F1;
--border-glass: rgba(99, 102, 241, 0.12);
```

| 项 | 值 |
|---|---|
| 圆角 | 1px / 2px / 16px / 12px / 999px |
| 渐变 | `linear-gradient(90deg, #1E1B3A, #6366F1, #06B6D4, #A855F7, #1E1B3A)`  `linear-gradient(90deg, #6366F1, #06B6D4)` |
| 阴影 | `0 4px 16px rgba(99, 102, 241, 0.08), 0 1px 4px rgba(99, 102, 241, 0.04)`  `0 4px 16px rgba(6, 182, 212, 0.08), 0 1px 4px rgba(6, 182, 212, 0.04)`  `0 4px 16px rgba(168, 85, 247, 0.08), 0 1px 4px rgba(168, 85, 247, 0.04)` |
| 毛玻璃 | `blur(16px) / blur(8px)` |
| 字体 | `'Inter', 'Noto Sans SC', sans-serif` / `inherit` |

## Liquid Glass

**文件**：`liquid-glass-components.html`　**标题**：Liquid Glass - 液态玻璃组件展示

> 被称为"动态的玻璃拟态"，增加了动态响应和光线折射效果，是玻璃拟态的进化版。

**配色变量**

```css
--bg: #0E0E1A;
--bg-glass: rgba(255, 255, 255, 0.04);
--text: #E8E8F0;
--text-light: #8888A8;
--accent: #7C83FF;
--border-glass: rgba(255, 255, 255, 0.1);
```

| 项 | 值 |
|---|---|
| 圆角 | 1px / 2px / 16px / 12px / 999px |
| 渐变 | `linear-gradient(90deg, #E8E8F0, #7C83FF, #4DFFFF, #C44DFF, #E8E8F0)`  `linear-gradient(90deg, #7C83FF, #4DFFFF)` |
| 阴影 | `0 0 8px rgba(124, 131, 255, 0.2), inset 0 0 8px rgba(124, 131, 255, 0.04)`  `0 0 10px rgba(77, 255, 255, 0.2), inset 0 0 8px rgba(77, 255, 255, 0.04)`  `0 0 10px rgba(196, 77, 255, 0.2), inset 0 0 8px rgba(196, 77, 255, 0.04)` |
| 毛玻璃 | `blur(12px) / blur(8px) / blur(16px)` |
| 字体 | `'Inter', 'Noto Sans SC', sans-serif` / `inherit` |

## Liquid Glass

**文件**：`liquid-glass-drop-demo.html`　**标题**：液态玻璃 (Liquid Glass) · 水滴边框效果

> 真实照片背景上的水滴玻璃质感——多层渐变叠加、高光弧线与双色边框，模拟水滴表面的光线折射。

**配色变量**

```css
--bg: #0E0E1A;
--text: #FFFFFF;
--text-light: rgba(255,255,255,0.6);
--border-hi: rgba(255,255,255,0.45);
--border-lo: rgba(255,255,255,0.18);
--glass-bg: rgba(255,255,255,0.06);
--glass-bg-hover: rgba(255,255,255,0.1);
```

| 项 | 值 |
|---|---|
| 圆角 | 1px / 2px / 20px / 50% / 14px |
| 渐变 | `linear-gradient(165deg, rgba(255,255,255,0.08)`  `linear-gradient(180deg, rgba(255,255,255,0.15)` |
| 阴影 | `0 12px 40px rgba(0,0,0,0.3),`  `0 4px 16px rgba(0,0,0,0.18),`  `0 6px 20px rgba(0,0,0,0.22),` |
| 毛玻璃 | `blur(50px) saturate(1.4) / blur(30px) saturate(1.2) / blur(20px) saturate(1.1) / blur(16px) / blur(10px) / blur(12px) / blur(24px) saturate(1.1)` |
| 字体 | `'Inter', 'Noto Sans SC', sans-serif` / `inherit` |

## 液态玻璃 - 水滴边框效果

**文件**：`liquid-glass-realistic.html`　**标题**：液态玻璃 - 水滴边框效果

| 项 | 值 |
|---|---|
| 圆角 | 50% / 999px / 24px / 16px / 2px |
| 渐变 | `linear-gradient(165deg, rgba(255,255,255,0.12)`  `linear-gradient(135deg, #667eea 0%, #764ba2 100%)` |
| 阴影 | `/* 外层柔和投影 */`  `0 4px 12px rgba(0,0,0,0.25)`  `0 0 6px rgba(255,255,255,0.3)` |
| 毛玻璃 | `blur(30px) saturate(1.3)` |
| 字体 | `'Inter', -apple-system, BlinkMacSystemFont, sans-serif` |

## Material Design

**文件**：`material-design-components.html`　**标题**：Material Design 材质设计 组件展示

> 由Google提出，介于扁平与拟物之间，通过层级、阴影和动画模拟纸张和墨水的物理世界，提供清晰的空间感。

**配色变量**

```css
--bg: #FAFAFA;
--text: #1D1B20;
--text-light: #787579;
--accent: #6750A4;
--surface: #FFFFFF;
```

| 项 | 值 |
|---|---|
| 圆角 | 2px / var(--radius-md) / 20px / 16px / 4px 4px 0 0 |
| 阴影 | `var(--shadow-6dp)`  `var(--shadow-1dp)`  `var(--shadow-3dp)` |
| 字体 | `'Roboto', 'Roboto Flex', 'Noto Sans SC', sans-serif` / `inherit` |

## Minimalism

**文件**：`minimalism-components.html`　**标题**：极简主义 (Minimalism) 组件展示

> "少即是多"。大量留白、无装饰的排版和有限的配色，只保留最核心的元素。

**配色变量**

```css
--bg: #F7F7F7;
--text: #1A1A1A;
--text-light: #888888;
--accent: #1A1A1A;
--swatch-1: #1A1A1A;
--swatch-2: #E8E8E8;
--swatch-3: #CCCCCC;
--swatch-4: #888888;
--swatch-5: #FFFFFF;
```

| 项 | 值 |
|---|---|
| 圆角 | 2px / 50% |
| 阴影 | `0 0 0 1px var(--divider) inset` |
| 字体 | `'Inter', 'Noto Sans SC', sans-serif` / `inherit` |

## Neo-Brutalism

**文件**：`neo-brutalism-components.html`　**标题**：Neo-Brutalism 组件展示

> "反精致"的风格，使用粗重的边框、强烈的对比色和直接大胆的排版，极具视觉冲击力。

**配色变量**

```css
--bg: #FFFDF7;
--text: #1A1A2E;
--text-light: #555555;
--accent: #FF6B6B;
```

| 项 | 值 |
|---|---|
| 圆角 | 无（直角） |
| 阴影 | `8px 8px 0 var(--black)`  `4px 4px 0 var(--black)`  `3px 3px 0 var(--black)` |
| 字体 | `'Inter', 'Noto Sans SC', sans-serif` / `inherit` |

## Neumorphism

**文件**：`neumorphism-components.html`　**标题**：新拟态 (Neumorphism) 组件展示

> 用和背景相似的卡片，通过精致的阴影（包括内阴影）来模拟出浮雕或嵌入的立体效果

**配色变量**

```css
--bg: #E0E5EC;
--text: #5A6E86;
--text-light: #8FA3BD;
--accent: #6B8BB5;
```

| 项 | 值 |
|---|---|
| 圆角 | 2px / 16px / 12px / 999px / 50% |
| 阴影 | `0 20px 60px rgba(0,0,0,0.3)`  `6px 6px 12px var(--shadow-dark), -6px -6px 12px var(--shadow-light)`  `4px 4px 8px var(--shadow-dark), -4px -4px 8px var(--shadow-light)` |
| 字体 | `'Inter', 'Noto Sans SC', sans-serif` / `inherit` |

## Retrofuturism

**文件**：`retrofuturism-components-light.html`　**标题**：Retrofuturism 复古未来主义 组件展示（浅色版）

> 浅色复古未来主义——70 年代太空手册与早期计算机终端的印刷美学，几何线条与霓虹色块。

**配色变量**

```css
--bg: #F5F0E8;
--bg-warm: #EDE7DB;
--text: #1A1A2E;
--text-light: #6B5B7B;
--accent: #BF5FFF;
--cyan: #0088AA;
--magenta: #CC2277;
--panel-bg: rgba(237, 231, 219, 0.8);
--border: #C8BFB0;
```

| 项 | 值 |
|---|---|
| 圆角 | 2px / 8px / 4px |
| 渐变 | `linear-gradient(0deg, transparent, transparent 3px, rgba(0,136,170,0.04)`  `linear-gradient(180deg, rgba(0,136,170,0.06)` |
| 阴影 | `3px 3px 0 var(--cyan)` |
| 字体 | `'Share Tech Mono', 'Noto Sans SC', monospace` / `'Orbitron', sans-serif` |

## Retrofuturism

**文件**：`retrofuturism-components.html`　**标题**：Retrofuturism 复古未来主义 组件展示

> 它是"过去的未来"，常混合蒸汽波、赛博朋克（霓虹灯、故障艺术）等元素，用复古视角想象未来世界。

**配色变量**

```css
--bg: #0D0221;
--text: #00FFFF;
--text-light: #FF69B4;
--accent: #BF5FFF;
--neon-magenta: #FF00FF;
--neon-cyan: #00FFFF;
--neon-purple: #BF5FFF;
--neon-pink: #FF6B9D;
--panel-bg: rgba(0, 0, 0, 0.5);
--glow-cyan: 0 0 10px rgba(0,255,255,0.5), 0 0 20px rgba(0,255,255,0.3);
--glow-pink: 0 0 10px rgba(255,105,180,0.5), 0 0 20px rgba(255,105,180,0.3);
--glow-purple: 0 0 10px rgba(191,95,255,0.5), 0 0 20px rgba(191,95,255,0.3);
--glow-magenta: 0 0 10px rgba(255,0,255,0.5), 0 0 20px rgba(255,0,255,0.3);
```

| 项 | 值 |
|---|---|
| 圆角 | 2px / 8px / 4px / 11px / 50% |
| 渐变 | `linear-gradient(0deg, transparent, transparent 2px, rgba(0,255,255,0.03)`  `linear-gradient(180deg, rgba(0,255,255,0.04)` |
| 阴影 | `var(--glow-purple)`  `var(--glow-cyan)`  `0 0 15px rgba(0,255,255,0.6), 0 0 30px rgba(0,255,255,0.4)` |
| 毛玻璃 | `blur(4px)` |
| 字体 | `'Share Tech Mono', 'Noto Sans SC', monospace` / `'Orbitron', sans-serif` |

## Skeuomorphism

**文件**：`skeuomorphism-audio-deck.html`　**标题**：拟物化 (Skeuomorphism) · Audio Deck

> 模仿现实物体的质感、纹理和效果，让用户感到熟悉、亲切。

**配色变量**

```css
--bg: #F5E6D3;
--text: #4A3728;
--text-light: #8B7355;
--accent: #B8860B;
```

| 项 | 值 |
|---|---|
| 圆角 | 2px / 16px / 8px / 999px / 50% |
| 渐变 | `linear-gradient(165deg, #F0EEEB 0%, #E8E6E3 40%, #E2E0DC 100%)`  `linear-gradient(145deg, #F4F2EF 0%, #EBE9E6 100%)` |
| 阴影 | `0 20px 60px rgba(0,0,0,0.3)`  `0 1px 0 rgba(255,255,255,0.7) inset,`  `0 2px 0 rgba(0,0,0,0.08),` |
| 字体 | `'Inter', 'Noto Sans SC', sans-serif` / `inherit` |

## Skeuomorphism

**文件**：`skeuomorphism-components.html`　**标题**：拟物化 (Skeuomorphism) 组件展示

> 模仿现实物体的质感、纹理和效果，让用户感到熟悉、亲切。

**配色变量**

```css
--bg: #F5E6D3;
--text: #4A3728;
--text-light: #8B7355;
--accent: #B8860B;
```

| 项 | 值 |
|---|---|
| 圆角 | 2px / 8px / 6px / 999px / 50% |
| 渐变 | `linear-gradient(135deg, #F5E6D3, #EED9C4)`  `linear-gradient(180deg, #F5E6D3 0%, #DEB887 100%)` |
| 阴影 | `0 20px 60px rgba(0,0,0,0.3)`  `4px 4px 8px rgba(160,82,45,0.3), -2px -2px 6px rgba(255,255,255,0.7)`  `2px 3px 6px rgba(160,82,45,0.3), -1px -1px 4px rgba(255,255,255,0.5)` |
| 字体 | `'Inter', 'Noto Sans SC', sans-serif` / `inherit` |

