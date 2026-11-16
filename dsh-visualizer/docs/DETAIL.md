# 可视化输出

这个插件让 agent 在对话流里直接画出一张图。

## 它能做什么

- 提供 `visual_guide`：返回画布、配色、字号、间距和安全限制，模型先读指南再画。
- 提供 `show_visual`：接收一段完整的 SVG 字符串，在工具调用位置渲染成卡片。
- 图直接显示在对话里，不是文件卡、不是下载链接；刷新后由工具调用参数重建。
- 适配流程图、架构图、数据图、对比表和界面草图。

## 怎么用

当用户要求“画个图”“用图解释”或一段关系用文字说不清时，模型先调用 `visual_guide`，再调用 `show_visual`，参数是 `svg`（完整 SVG）、`title`、可选的 `caption` 和 `loading`。

示例：

```xml
<svg viewBox="0 0 720 320" xmlns="http://www.w3.org/2000/svg">
  <rect x="40" y="120" width="180" height="64" rx="8" fill="#eef4ff" stroke="#2563eb"/>
  <text x="60" y="158" font-size="13" fill="#1f2328">请求进入</text>
  <path d="M220 152h120" stroke="#57606a" stroke-width="1" stroke-linecap="round"/>
  <polygon points="340,148 350,152 340,156" fill="#57606a"/>
  <rect x="350" y="120" width="180" height="64" rx="8" fill="#f6f8fa" stroke="#d0d7de"/>
  <text x="370" y="158" font-size="13" fill="#1f2328">校验与渲染</text>
</svg>
```

## 边界

- 只接受 SVG；HTML、脚本、iframe、事件属性、外部 URL、`<use>`、`<image>`、`<foreignObject>` 和动画元素都会被拒绝。
- 单图上限 24 KB、1500 个节点；每轮最多 3 张。
- 图形使用固定浅色画布，图内颜色不跟随深色主题。
- 不做导出、不做交互、不做“边生成边显示”；生成期间只显示骨架和文案。
- 安全边界由插件自己承担：宿主与客户端都会解析并校验同一份白名单，客户端只把结果构造成 React 元素。
