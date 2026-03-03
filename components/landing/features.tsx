"use client";

import { motion } from "framer-motion";
import { Brain, Activity, Network, Terminal } from "lucide-react";
import { cn } from "@/lib/utils";

const features = [
    {
        icon: Network,
        title: "One AI, One Consciousness",
        description: "Your AI on Telegram doesn't know what you said on Slack? Not here. Zylos routes all channels through a single gateway — one conversation, one memory, one personality. Every message persisted and fully queryable.",
        className: "",
    },
    {
        icon: Brain,
        title: "Your Context, Guaranteed",
        description: "Other frameworks silently lose memory during context compaction. Zylos auto-saves before compaction runs, with five-layer Inside Out memory that knows what to keep and what to compress. Your AI never wakes up with amnesia.",
        className: "",
    },
    {
        icon: Activity,
        title: "Self-Healing by Default",
        description: "Crash recovery, heartbeat probes, health monitoring, context management, and auto-upgrades — all built in. Your AI detects its own problems and fixes them. It stays alive while you sleep.",
        className: "",
    },
    {
        icon: Terminal,
        title: "Powered by Claude Code",
        description: "Built on Anthropic's official AI agent runtime. New Claude capabilities ship to your agent automatically. And because it can program, your AI writes new skills, integrates services, and evolves with your needs.",
        className: "md:col-span-2",
    },
];

export function LandingFeatures() {
    return (
        <section id="features" className="py-24 bg-black/20 relative border-t border-white/5">
            <div className="container mx-auto px-4">

                <div className="mb-16">
                    <h2 className="text-3xl md:text-4xl font-bold mb-4">Why Zylos?</h2>
                    <p className="text-muted-foreground max-w-2xl text-lg">
                        Not just a chat session — a reliable, always-on AI that remembers, communicates, and acts on its own.
                    </p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 auto-rows-[minmax(180px,auto)]">
                    {features.map((feature, i) => (
                        <motion.div
                            key={feature.title}
                            initial={{ opacity: 0, y: 20 }}
                            whileInView={{ opacity: 1, y: 0 }}
                            viewport={{ once: true }}
                            transition={{ delay: i * 0.1 }}
                            className={cn(
                                "group relative overflow-hidden rounded-3xl border border-white/10 bg-white/5 p-8 hover:bg-white/10 transition-colors",
                                feature.className
                            )}
                        >
                            <div className="absolute top-0 right-0 p-8 opacity-20 group-hover:opacity-40 transition-opacity">
                                <feature.icon className="w-24 h-24 -mr-8 -mt-8" />
                            </div>

                            <div className="relative z-10 flex flex-col h-full justify-between">
                                <div>
                                    <div className="w-10 h-10 rounded-full bg-primary/20 flex items-center justify-center mb-4 text-primary">
                                        <feature.icon className="w-5 h-5" />
                                    </div>
                                    <h3 className="text-xl font-bold mb-2 text-white">{feature.title}</h3>
                                    <p className="text-muted-foreground leading-relaxed">{feature.description}</p>
                                </div>
                            </div>
                        </motion.div>
                    ))}
                </div>

            </div>
        </section>
    );
}
