"use client";

import { motion } from "framer-motion";
import { ArrowDown, Cpu, Sparkles, Twitter } from "lucide-react";
import { Button } from "@/components/ui/button";

export function Hero() {
    return (
        <section className="relative min-h-[55vh] flex flex-col items-center justify-center overflow-hidden pt-20 pb-10">

            {/* Background Elements */}
            <div className="absolute inset-0 w-full h-full bg-[radial-gradient(circle_at_center,rgba(50,50,50,0.1)_0%,rgba(0,0,0,0.5)_100%)] pointer-events-none" />
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[500px] h-[500px] bg-primary/10 rounded-full blur-[120px] animate-pulse" />
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[300px] h-[300px] bg-secondary/10 rounded-full blur-[80px]" />

            <motion.div
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.8, ease: "easeOut" }}
                className="z-10 text-center px-4"
            >
                <motion.div
                    initial={{ y: 20, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    transition={{ delay: 0.2 }}
                    className="flex items-center justify-center gap-2 mb-6"
                >
                    <span className="px-3 py-1 rounded-full border border-primary/30 bg-primary/10 text-primary text-xs font-mono tracking-widest uppercase flex items-center gap-2">
                        <Sparkles className="w-3 h-3" />
                        System Online
                    </span>
                </motion.div>

                <h1 className="text-7xl md:text-9xl font-black tracking-tighter mb-4 relative">
                    <span className="bg-clip-text text-transparent bg-gradient-to-b from-white via-white/80 to-white/20">
                        ZYLOS
                    </span>
                    <motion.div
                        className="absolute -inset-1 blur-2xl bg-primary/20 -z-10"
                        animate={{ opacity: [0.5, 0.8, 0.5] }}
                        transition={{ duration: 4, repeat: Infinity }}
                    />
                </h1>

                <motion.p
                    initial={{ y: 20, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    transition={{ delay: 0.4 }}
                    className="text-xl md:text-2xl text-muted-foreground font-light max-w-2xl mx-auto leading-relaxed mb-8"
                >
                    A personal AI assistant that <span className="text-foreground font-medium">grows</span>, <span className="text-foreground font-medium">learns</span>, and <span className="text-foreground font-medium">evolves</span> alongside its creator.
                </motion.p>

                <motion.div
                    initial={{ y: 20, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    transition={{ delay: 0.6 }}
                    className="flex flex-col md:flex-row gap-4 justify-center items-center"
                >
                    <div className="flex items-center gap-2 text-sm text-muted-foreground bg-white/5 px-4 py-2 rounded-lg border border-white/10 backdrop-blur-sm">
                        <Cpu className="w-4 h-4 text-primary" />
                        <span>Powered by Claude</span>
                    </div>

                    <a href="https://twitter.com/zzh_wxj" target="_blank" rel="noopener noreferrer">
                        <Button variant="outline" className="gap-2 border-white/10 bg-white/5 hover:bg-white/10 hover:text-primary transition-all">
                            <Twitter className="w-4 h-4" />
                            Follow on X
                        </Button>
                    </a>
                </motion.div>
            </motion.div>

        </section >
    );
}
