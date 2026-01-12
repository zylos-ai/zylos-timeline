---
date: "2026-01-10"
title: "Claude Code Skills 深度解析 - Part 1: 官方文档与核心概念"
description: "Research notes on Claude Code Skills 深度解析 - Part 1: 官方文档与核心概念"
tags:
  - research
---


*研究日期: 2026-01-10*
*系列: Claude Code Skills (1/3)*

> **系列导航**
> - **Part 1: 核心概念** (当前)
> - [Part 2: 高级模式与最佳实践](2026-01-10-claude-code-skills-part2.md)
> - [Part 3: 生态系统与实战案例](2026-01-10-claude-code-skills-part3.md)

## 概述

Skills 是 Anthropic 于 2025年10月16日发布的重要功能，被 Simon Willison 评价为"可能比 MCP 更重要"。Skills 本质上是教会 Claude 如何执行特定任务的 Markdown 文件集合。

## 核心特性

### 1. 什么是 Skills？

Skills 是包含指令、脚本和资源的文件夹，Claude 在需要时自动加载。

**关键特点：**
- **Model-invoked**: Claude 根据任务自动选择相关 skill，无需显式调用
- **Token 高效**: 启动时只加载简短的 YAML 描述，完整内容按需加载
- **可组合**: 多个 skills 可以协同工作
- **可移植**: 跨 Claude Apps、Claude Code 和 API 使用

### 2. Skills vs 其他功能

| 功能 | 触发方式 | 适用场景 | 作用域 |
|------|----------|----------|--------|
| **Skills** | 自动发现 | 复杂能力、团队工作流 | Project/Personal/Enterprise |
| **Slash Commands** | 显式 `/command` | 快速可复用提示 | Project/Personal |
| **CLAUDE.md** | 自动加载 | 项目级指令 | Project |
| **Hooks** | 事件触发 | 工具调用前后执行脚本 | Project |
| **MCP Servers** | Claude 调用 | 连接外部工具和数据 | 配置范围 |

## 文件结构

### 基本结构
```
my-skill/
└── SKILL.md          # 必需文件
```

### 复杂结构
```
pdf-processing/
├── SKILL.md          # 主入口（保持 <500 行）
├── FORMS.md          # 详细文档
├── REFERENCE.md      # API 参考
├── EXAMPLES.md       # 使用示例
└── scripts/
    ├── analyze.py    # 工具脚本
    └── validate.py   # 验证脚本
```

## SKILL.md 格式

```yaml
---
# 必需字段
name: skill-name              # 小写+连字符，最大64字符
description: |                # 最大1024字符，用于自动发现
  详细描述 skill 做什么以及何时使用。
  包含具体的触发词，如 "PDF, 表单, 文档提取"

# 可选字段
allowed-tools: Read, Grep, Glob    # 限制可用工具
model: claude-sonnet-4-20250514    # 指定模型
context: fork                       # 在隔离子代理中运行
agent: Explore                      # 代理类型（配合 context: fork）
user-invocable: true               # 是否显示在菜单
disable-model-invocation: false    # 是否禁止程序化调用
hooks:                              # 生命周期钩子
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "./scripts/check.sh"
---

# Skill 标题

## 使用说明
[Markdown 格式的详细指令]
```

## 存储位置与优先级

| 位置 | 路径 | 适用范围 | 优先级 |
|------|------|----------|--------|
| Enterprise | 托管设置 | 组织所有用户 | 最高 |
| Personal | `~/.claude/skills/` | 个人所有项目 | 高 |
| Project | `.claude/skills/` | 项目所有开发者 | 中 |
| Plugin | 插件捆绑 | 安装插件的用户 | 低 |

## Description 编写最佳实践

Description 是 skill 被发现的关键，必须精心编写。

**好的示例：**
```yaml
description: |
  Extract text and tables from PDF files, fill forms, merge documents.
  Use when working with PDF files or when the user mentions PDFs,
  forms, or document extraction.
```

**差的示例：**
```yaml
description: Helps with documents  # 太模糊！
```

**编写原则：**
1. 使用第三人称："Processes Excel files..." 而非 "I can help you..."
2. 包含具体触发词：PDF, Excel, 表单, 数据分析等
3. 说明"做什么"和"何时使用"

## 工具限制

```yaml
allowed-tools: Read, Grep, Glob           # 只读操作
allowed-tools: Read, Bash(python:*)       # 只允许 Python
allowed-tools:                            # YAML 列表格式
  - Read
  - Grep
  - Bash(grep:*)
```

## 可见性控制

| 设置 | 菜单可见 | Skill Tool | 自动发现 | 用途 |
|------|----------|------------|----------|------|
| 默认 | ✅ | ✅ | ✅ | 用户可直接调用 |
| `user-invocable: false` | ❌ | ✅ | ✅ | Claude 使用，用户不见菜单 |
| `disable-model-invocation: true` | ✅ | ❌ | ✅ | 仅用户可调用 |

## 我们系统的现有 Skills

### wechat-reader
```yaml
name: wechat-reader
description: Read and summarize WeChat articles (mp.weixin.qq.com links)
allowed-tools: Read, Bash, Write
```
- 用途：读取微信公众号文章
- 特点：使用 Playwright 绕过验证码

### browser
```yaml
name: browser
description: Browser automation operations
allowed-tools: Bash, Read, Write
```
- 用途：浏览器自动化
- 特点：CDP 协议，可视化覆盖层

## 行业分析

### Simon Willison 的观点

> "Skills 可能比 MCP 更重要，尽管它们看起来更简单。"

**他的理由：**
1. **简单即力量**: MCP 需要复杂协议规范，Skills 只需 Markdown + 脚本
2. **跨模型兼容**: 不仅限于 Claude，其他 CLI 工具也能使用
3. **实用性强**: 一个数据新闻代理可以仅用 Markdown 文件夹构建

### 商业合作伙伴

Anthropic 已与以下公司合作发布官方 Skills：
- Atlassian, Canva, Cloudflare
- Figma, Notion, Ramp, Sentry, Box

## 开放标准

Agent Skills 作为开放标准发布在 agentskills.io，支持跨平台移植。这与 MCP 的发展路径类似 - Anthropic 正在定义 AI Agent 的行业标准。

## 后续研究计划

- **Part 2**: 高级模式与最佳实践 - Hooks 集成、复杂工作流、调试技巧
- **Part 3**: 实际案例分析 - 社区 skills、生产环境应用、自定义开发

---

## 参考资料

- [Anthropic Official: Introducing Agent Skills](https://claude.com/blog/skills)
- [Simon Willison: Claude Skills are awesome](https://simonwillison.net/2025/Oct/16/claude-skills/)
- [InfoQ: Anthropic Introduces Skills](https://www.infoq.com/news/2025/10/anthropic-claude-skills/)
- [The New Stack: Agent Skills - Anthropic's Next Bid](https://thenewstack.io/agent-skills-anthropics-next-bid-to-define-ai-standards/)
