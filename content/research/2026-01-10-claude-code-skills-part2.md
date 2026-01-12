---
date: "2026-01-10"
title: "Claude Code Skills 深度解析 - Part 2: 高级模式与最佳实践"
description: "Research notes on Claude Code Skills 深度解析 - Part 2: 高级模式与最佳实践"
tags:
  - research
---


*研究日期: 2026-01-10*
*系列: Claude Code Skills (2/3)*

> **系列导航**
> - [Part 1: 核心概念](2026-01-10-claude-code-skills-part1.md)
> - **Part 2: 高级模式与最佳实践** (当前)
> - [Part 3: 生态系统与实战案例](2026-01-10-claude-code-skills-part3.md)

## 概述

Part 2 聚焦高级功能：Hooks 生命周期、隔离执行、工具限制和调试技巧。

## 1. Hooks 集成

### 三种 Hook 类型

| Hook | 触发时机 | 能否阻止 | 用途 |
|------|----------|----------|------|
| **PreToolUse** | 工具执行前 | ✅ 可阻止 | 验证输入、安全检查 |
| **PostToolUse** | 工具执行后 | ❌ 不可阻止 | 格式化、日志、通知 |
| **Stop** | Claude 结束响应时 | ✅ 可阻止 | 确保任务完成 |

### PreToolUse - 拦截工具调用

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "~/.claude/hooks/validate-bash.py"
          }
        ]
      }
    ]
  }
}
```

**Matcher 模式**:
- `Write` - 精确匹配
- `Edit|Write` - 正则匹配多个
- `*` 或 `""` - 匹配所有工具
- `mcp__server__tool` - MCP 工具

**决策控制** (JSON 输出):
```json
{
  "hookSpecificOutput": {
    "permissionDecision": "allow|deny|ask",
    "permissionDecisionReason": "原因说明"
  }
}
```

**退出码**:
- `0` = 允许（除非 JSON 说 deny）
- `2` = 阻止工具调用

### PostToolUse - 后处理

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "npx prettier --write \"$FILE_PATH\""
          }
        ]
      }
    ]
  }
}
```

### Stop Hook - 防止提前结束

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "prompt",
            "prompt": "检查任务是否完成...",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

## 2. Context Fork - 隔离执行

### 什么是 context: fork?

在独立子代理上下文中运行，具有：
- 独立对话历史
- 独立权限系统
- 指定工具访问
- 独立 context window

### 配置语法

```yaml
---
name: code-analysis
description: 深度代码分析
context: fork
agent: general-purpose
model: claude-sonnet-4-20250514
allowed-tools: Read, Grep, Glob
---
```

### 可用 Agent 类型

| Agent | 模型 | 工具 | 用途 |
|-------|------|------|------|
| **Explore** | Haiku (快) | 只读 | 文件发现、搜索 |
| **Plan** | 继承父级 | 只读 | 计划模式研究 |
| **general-purpose** | 继承父级 | 全部 | 复杂多步操作 |
| **自定义** | 自定义 | 自定义 | .claude/agents/ |

### 何时使用 Fork

✅ 适合:
- 复杂多步操作（避免污染主对话）
- 产生大量输出（测试、日志、报告）
- 需要不同工具限制
- 大数据处理
- 探索性分析

❌ 不适合:
- 快速简单任务（开销大）
- 需要与用户频繁交互

## 3. 工具限制 (allowed-tools)

### 基本语法

```yaml
# 逗号分隔
allowed-tools: Read, Grep, Glob

# YAML 列表
allowed-tools:
  - Read
  - Grep
  - Glob
```

### Bash 命令限制

```yaml
allowed-tools:
  - Bash(python:*)     # 只允许 python 命令
  - Bash(npm:*)        # 只允许 npm 命令
  - Bash(git:*)        # 只允许 git 命令
  - Bash(ls|pwd|cat)   # 特定命令
```

### 创建只读 Skill

```yaml
---
name: audit-analyzer
description: 分析审计日志，不做任何修改
allowed-tools:
  - Read
  - Grep
  - Bash(head|tail|cat|grep|jq)
---
```

### 安全最佳实践

**多层防御**:
```yaml
---
name: secure-db-query
description: 只读数据库查询
allowed-tools:
  - Bash(psql|sqlite3)
hooks:
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "./validate-readonly.sh"
---
```

## 4. 调试技巧

### Skill 不触发？

**检查清单**:

1. **验证加载**: 问 Claude "What Skills are available?"

2. **检查路径**:
   ```
   ✅ ~/.claude/skills/my-skill/SKILL.md
   ✅ .claude/skills/my-skill/SKILL.md
   ❌ ~/.claude/skills/SKILL.md (错误位置)
   ❌ skill.md (大小写敏感!)
   ```

3. **检查 Description**: 必须包含具体触发词
   ```yaml
   # 差
   description: Helps with documents

   # 好
   description: Extract text from PDF files, fill forms.
                Use when working with PDFs or document extraction.
   ```

4. **检查 YAML 语法**:
   ```bash
   python3 -c "import yaml; yaml.safe_load(open('SKILL.md'))"
   ```

5. **Debug 模式**:
   ```bash
   claude --debug 2>&1 | grep -i skill
   ```

### 常见错误

| 错误 | 原因 | 解决 |
|------|------|------|
| Skill 不在列表 | YAML 语法错误 | 验证 frontmatter |
| 加载但不触发 | description 太模糊 | 添加具体关键词 |
| 脚本权限错误 | 不可执行 | `chmod +x scripts/*.py` |
| 依赖缺失 | 包未安装 | `pip install xxx` |

## 5. 高级工作流模式

### 多步检查清单

```yaml
---
name: project-setup
description: 初始化新项目
context: fork
---

## 设置步骤

### Step 1: 创建目录结构
- [ ] 创建 src/
- [ ] 创建 tests/
- [ ] 验证目录存在

### Step 2: 初始化 Git
- [ ] git init
- [ ] 创建 .gitignore
- [ ] 首次提交
```

### 反馈循环

```yaml
---
name: code-improver
description: 迭代改进代码质量
hooks:
  PostToolUse:
    - matcher: "Edit|Write"
      hooks:
        - type: command
          command: "./run-linter.sh"
---

## 流程
1. 分析代码问题
2. 修复问题
3. 运行验证
4. 重复直到通过
```

### 渐进式加载

```
skill/
├── SKILL.md          # 概述 (<500行)
├── reference/
│   ├── api.md        # 按需加载
│   └── examples.md   # 按需加载
└── scripts/
    └── validator.py  # 执行，不加载
```

## 功能决策表

| 功能 | 使用场景 | 示例 |
|------|----------|------|
| PreToolUse | 阻止危险操作 | 禁止 rm -rf |
| PostToolUse | 自动格式化 | prettier |
| Stop Hook | 确保完成 | 检查所有任务 |
| context: fork | 隔离大任务 | 测试套件 |
| allowed-tools | 安全限制 | 只读分析 |
| 检查清单 | 复杂初始化 | 项目设置 |
| 反馈循环 | 迭代改进 | 代码质量 |

## 关键洞察

1. **Hooks 是确定性的**: 用于需要严格控制的场景
2. **Fork 有成本**: 每个 fork 消耗独立 token 预算
3. **工具限制是安全层**: 结合 hooks 实现多层防御
4. **Description 是发现的关键**: 写好 description 比写好指令更重要

---

## 参考资料

- [Hooks Guide](https://code.claude.com/docs/en/hooks-guide.md)
- [Hooks Reference](https://code.claude.com/docs/en/hooks.md)
- [Skills Documentation](https://code.claude.com/docs/en/skills.md)
- [Subagents Documentation](https://code.claude.com/docs/en/sub-agents.md)
