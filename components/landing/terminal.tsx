"use client";

import { motion } from "framer-motion";
import { useEffect, useState } from "react";

type Line = {
    text: string;
    color: string;
    delay: number;
};

const lines: Line[] = [
    { text: "> zylos init", color: "text-white", delay: 0 },
    { text: "ℹ Checking prerequisites...", color: "text-blue-400", delay: 800 },
    { text: "✔ tmux, git, PM2, Claude Code installed", color: "text-green-400", delay: 2000 },
    { text: "✔ Claude authenticated", color: "text-green-400", delay: 2800 },
    { text: "ℹ Creating ~/zylos/ directory...", color: "text-blue-400", delay: 3600 },
    { text: "✔ Memory, skills, and services initialized", color: "text-green-400", delay: 4800 },
    { text: "✔ Background services started", color: "text-green-400", delay: 5600 },
    { text: "✔ Claude launched in tmux session", color: "text-green-400", delay: 6400 },
    { text: "✨ Zylos is now alive.", color: "text-primary font-bold", delay: 7200 },
];

export function TerminalDemo() {
    const [visibleIndex, setVisibleIndex] = useState(0);

    useEffect(() => {
        // Reset when in view? For now just run once
        let timeouts: NodeJS.Timeout[] = [];

        // Clear previous
        setVisibleIndex(0);

        lines.forEach((line, index) => {
            const timeout = setTimeout(() => {
                setVisibleIndex(prev => Math.max(prev, index + 1));
            }, line.delay);
            timeouts.push(timeout);
        });

        return () => timeouts.forEach(clearTimeout);
    }, []);

    return (
        <section className="py-24 relative overflow-hidden">
            <div className="container mx-auto px-4 flex flex-col items-center">

                <div className="text-center mb-16">
                    <h2 className="text-3xl md:text-5xl font-bold mb-6">Born in the Terminal.</h2>
                    <p className="text-muted-foreground text-lg max-w-2xl mx-auto">
                        A Linux server and a <a href="https://claude.ai" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">Claude</a> or <a href="https://github.com/openai/codex" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">Codex</a> subscription — that&apos;s all you need. <br />
                        One command to install. Local-first, privacy-focused, always online.
                    </p>
                </div>

                <motion.div
                    initial={{ opacity: 0, y: 40 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true, margin: "-100px" }}
                    className="w-full max-w-3xl bg-[hsl(220,50%,6%)] rounded-xl border border-border shadow-2xl overflow-hidden font-mono text-sm md:text-base relative group"
                >
                    {/* Window Controls */}
                    <div className="bg-white/5 px-4 py-3 flex items-center gap-2 border-b border-white/5 dark:border-white/5">
                        <div className="w-3 h-3 rounded-full bg-red-500/80" />
                        <div className="w-3 h-3 rounded-full bg-yellow-500/80" />
                        <div className="w-3 h-3 rounded-full bg-green-500/80" />
                        <div className="ml-auto text-xs text-muted-foreground">zsh — 80x24</div>
                    </div>

                    {/* Terminal Content */}
                    <div className="p-6 md:p-8 min-h-[400px] flex flex-col">
                        {lines.slice(0, visibleIndex).map((line, i) => (
                            <motion.div
                                key={i}
                                initial={{ opacity: 0, x: -10 }}
                                animate={{ opacity: 1, x: 0 }}
                                className={`mb-2 ${line.color}`}
                            >
                                {line.text}
                            </motion.div>
                        ))}

                        {visibleIndex === lines.length && (
                            <motion.div
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                className="text-white mt-2"
                            >
                                &gt; <span className="animate-pulse">_</span>
                            </motion.div>
                        )}
                    </div>

                    {/* Reflection */}
                    <div className="absolute top-0 right-0 w-full h-full bg-gradient-to-bl from-white/5 to-transparent pointer-events-none" />
                </motion.div>

            </div>
        </section>
    );
}
