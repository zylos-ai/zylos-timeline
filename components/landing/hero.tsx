"use client";

import { motion } from "framer-motion";
import { ArrowRight, Terminal, Copy, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { Link } from "@/lib/i18n/navigation";

export function LandingHero() {
    const t = useTranslations("Hero");
    const [copied, setCopied] = useState(false);
    const command = "curl -fsSL https://raw.githubusercontent.com/zylos-ai/zylos-core/main/scripts/install.sh | bash";

    const handleCopy = () => {
        navigator.clipboard.writeText(command);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    return (
        <section className="relative min-h-[90vh] flex flex-col justify-center overflow-hidden pt-32 pb-20">

            {/* Background Effects */}
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_50%,rgba(56,189,248,0.05)_0%,rgba(0,0,0,0)_50%)] pointer-events-none" />
            <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-foreground/10 to-transparent" />

            <div className="container mx-auto px-4 grid lg:grid-cols-2 gap-16 items-center relative z-10">

                {/* Left Column: Content */}
                <motion.div
                    initial={{ opacity: 0, x: -20 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ duration: 0.6 }}
                    className="text-center lg:text-left"
                >
                    <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary/10 border border-primary/20 text-primary text-xs font-mono mb-6 uppercase tracking-wider">
                        <span className="relative flex h-2 w-2">
                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75"></span>
                            <span className="relative inline-flex rounded-full h-2 w-2 bg-primary"></span>
                        </span>
                        {t("badge")}
                    </div>

                    <h1 className="text-5xl md:text-7xl lg:text-8xl font-black tracking-tighter mb-6 leading-[1] text-foreground">
                        {t("title")} <br />
                        <span className="text-transparent bg-clip-text bg-gradient-to-r from-primary via-cyan-400 to-blue-500">{t("titleHighlight")}</span>
                    </h1>

                    <p className="text-xl text-muted-foreground mb-6 max-w-xl mx-auto lg:mx-0 leading-relaxed font-light">
                        {t.rich("description", {
                            highlight: (chunks) => <span className="text-foreground font-medium">{chunks}</span>,
                        })}
                    </p>

                    <p className="text-sm text-muted-foreground/70 mb-10 max-w-xl mx-auto lg:mx-0 font-mono">
                        {t.rich("compatibility", {
                            link: (chunks) => (
                                <a href="https://github.com/openclaw/openclaw" className="text-primary/80 hover:text-primary transition-colors" target="_blank" rel="noopener noreferrer">{chunks}</a>
                            ),
                        })}
                    </p>

                    <div className="flex flex-col items-center lg:items-start gap-4">
                        <div className="relative group w-full max-w-xl">
                            <div className="absolute -inset-0.5 bg-gradient-to-r from-primary to-blue-600 rounded-lg blur opacity-30 group-hover:opacity-75 transition duration-200"></div>
                            <div className="relative flex items-center bg-background rounded-lg border border-border p-1 pr-2">
                                <div className="flex items-start px-4 py-3 font-mono text-sm text-foreground/80 flex-1 min-w-0">
                                    <span className="mr-3 text-muted-foreground shrink-0">$</span>
                                    <span className="break-all">{command}</span>
                                </div>
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground shrink-0"
                                    onClick={handleCopy}
                                >
                                    {copied ? <Check className="w-4 h-4 text-green-500" /> : <Copy className="w-4 h-4" />}
                                </Button>
                            </div>
                        </div>

                        <Link href="/timeline">
                            <Button variant="ghost" className="gap-2 h-12 px-6 group text-muted-foreground hover:text-foreground">
                                {t("seeEvolution")}
                                <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
                            </Button>
                        </Link>
                    </div>
                </motion.div>

                {/* Right Column: Dynamic Visual */}
                <motion.div
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ duration: 0.8, delay: 0.2 }}
                    className="relative h-[400px] lg:h-[600px] w-full flex items-center justify-center"
                >
                    {/* Central Core */}
                    <div className="relative z-20 w-32 h-32 lg:w-40 lg:h-40 bg-secondary backdrop-blur-xl border border-primary/30 rounded-full flex flex-col items-center justify-center shadow-[0_0_80px_rgba(var(--primary),0.3)] ring-1 ring-foreground/10">
                        <div className="absolute inset-0 rounded-full border border-primary/20 animate-pulse" />
                        <Terminal className="w-12 h-12 text-primary mb-2" />
                        <span className="text-[10px] font-mono text-primary/80 tracking-widest">CORE</span>
                    </div>

                    {/* Orbiting Satellites */}
                    {[
                        { label: "Telegram", x: 0, y: -180, delay: 0 },
                        { label: "Lark", x: 160, y: 100, delay: 1 },
                        { label: "Web", x: -160, y: 100, delay: 2 },
                    ].map((node, i) => (
                        <motion.div
                            key={node.label}
                            className="absolute z-10"
                            initial={{ x: node.x, y: node.y }}
                            animate={{
                                y: [node.y - 10, node.y + 10, node.y - 10],
                            }}
                            transition={{
                                duration: 4,
                                repeat: Infinity,
                                ease: "easeInOut",
                                delay: node.delay
                            }}
                        >
                            <div className="flex flex-col items-center gap-2">
                                <div className="w-20 h-20 bg-secondary/80 backdrop-blur-md border border-border rounded-2xl flex items-center justify-center shadow-lg hover:border-primary/50 transition-colors group cursor-default">
                                    <span className="text-xs font-mono text-muted-foreground group-hover:text-primary transition-colors">{node.label}</span>
                                </div>
                                <div className="w-px h-10 bg-gradient-to-b from-foreground/10 to-transparent" />
                            </div>

                            {/* Connection Line to Center (Visual only, tricky with SVG, skipping for now to rely on proximity) */}
                        </motion.div>
                    ))}

                    {/* Background Rings */}
                    <div className="absolute inset-center border border-foreground/5 rounded-full w-[300px] h-[300px] opacity-20" />
                    <div className="absolute inset-center border border-foreground/5 rounded-full w-[500px] h-[500px] opacity-10 dashed" />

                </motion.div>
            </div>
        </section>
    );
}
