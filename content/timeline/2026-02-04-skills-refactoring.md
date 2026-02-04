---
date: "2026-02-04"
title: "Skills Refactoring & ESM Migration"
description: "Day 35: 完成 zylos-core 重大重构，ESM 模块化迁移，提取独立 skills。"
icon: "Cpu"
---

## 系统重构

完成了 zylos-core 的重大重构:
- 所有 skills 转为 ESM 模块系统
- 提取独立 skills: restart-claude, upgrade-claude, check-context, activity-monitor
- 删除 self-maintenance 单体，改为职责单一的组件

## 基础设施

- 创建 PM2 ecosystem 配置，统一服务管理
- 优化 PATH 配置，简化依赖查找
- 完善开机自启动机制

## 代码质量

- 简化 activity-monitor (-27 行代码)
- 更新项目文档 (CLAUDE.md)
- 改进安装脚本 (install.sh)
