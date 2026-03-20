"use client";

import { motion } from "framer-motion";
import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";

type Line = {
    text: string;
    color: string;
    delay: number;
};

const lineColors = [
    "text-white",
    "text-blue-400",
    "text-green-400",
    "text-green-400",
    "text-blue-400",
    "text-green-400",
    "text-green-400",
    "text-green-400",
    "text-primary font-bold",
];

const lineDelays = [0, 800, 2000, 2800, 3600, 4800, 5600, 6400, 7200];

const lineKeys = [
    "line0", "line1", "line2", "line3", "line4",
    "line5", "line6", "line7", "line8",
] as const;

export function TerminalDemo() {
    const t = useTranslations("Terminal");
    const [visibleIndex, setVisibleIndex] = useState(0);

    const lines: Line[] = useMemo(() =>
        lineKeys.map((key, i) => ({
            text: t(key),
            color: lineColors[i],
            delay: lineDelays[i],
        })),
    [t]);

    useEffect(() => {
        const timeouts: NodeJS.Timeout[] = [];
        setVisibleIndex(0);

        lines.forEach((line, index) => {
            const timeout = setTimeout(() => {
                setVisibleIndex(prev => Math.max(prev, index + 1));
            }, line.delay);
            timeouts.push(timeout);
        });

        return () => timeouts.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return (
        <section className="py-24 relative overflow-hidden">
            <div className="container mx-auto px-4 flex flex-col items-center">

                <div className="text-center mb-16">
                    <h2 className="text-3xl md:text-5xl font-bold mb-6">{t("heading")}</h2>
                    <p className="text-muted-foreground text-lg max-w-2xl mx-auto">
                        {t.rich("subheading", {
                            claude: (chunks) => (
                                <a href="https://claude.ai" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">{chunks}</a>
                            ),
                            codex: (chunks) => (
                                <a href="https://github.com/openai/codex" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">{chunks}</a>
                            ),
                        })}
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
