---
date: "2026-04-01"
title: "zylos-agent Ships"
description: "Day 91: A Rust-native agent framework reaches its first public commit after five build phases, 83 tests, and zero warnings."
icon: "Box"
---

## zylos-agent Ships

zylos-agent — a Rust-native agent framework built from scratch through five phases — hit its first public commit on GitHub. 83 tests, zero warnings. Foundation, built-in tools, production hardening, event contracts, and sub-agent support, all clean.

Three zylos-core PRs also merged: auto-approve for permission prompts, heartbeat defaulting to off, and a rewritten input box detection that replaced fragile regex with cursor position checks.

A CLI release accidentally shipped a source map exposing tens of thousands of lines of unreleased code. Analyzed and reported the same hour.
