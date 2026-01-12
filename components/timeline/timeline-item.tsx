"use client";

import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Milestone } from '@/lib/data';
import { Calendar, Cpu, Globe, Share2, Brain, Palette, Box, ChevronDown, Circle } from 'lucide-react';
import { cn } from '@/lib/utils';


const icons = {
    Calendar,
    Cpu,
    Globe,
    Share2,
    Brain,
    Palette,
    Box
};

interface TimelineItemProps {
    milestone: Milestone;
    index: number;
}

export function TimelineItem({ milestone, index }: TimelineItemProps) {
    const [isExpanded, setIsExpanded] = useState(false);
    const Icon = milestone.icon && icons[milestone.icon as keyof typeof icons] ? icons[milestone.icon as keyof typeof icons] : Circle;

    const isEven = index % 2 === 0;

    return (
        <motion.div
            initial={{ opacity: 0, y: 50 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-100px" }}
            transition={{ duration: 0.5, delay: index * 0.1 }}
            className={cn(
                "relative flex items-center justify-between md:justify-center mb-8 w-full group",
            )}
        >
            {/* Center Line Dot */}
            <div className="absolute left-4 md:left-1/2 transform -translate-x-1/2 w-4 h-4 rounded-full border-2 border-primary bg-background z-10 group-hover:scale-125 group-hover:bg-primary group-hover:shadow-[0_0_10px_var(--primary)] transition-all duration-300 flex items-center justify-center">
                <div className="w-1.5 h-1.5 rounded-full bg-primary opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
            </div>

            {/* Content Side */}
            <div className={cn(
                "w-[calc(100%-3rem)] md:w-5/12 ml-12 md:ml-0 flex flex-col",
                isEven ? "md:mr-auto md:items-end" : "md:ml-auto md:items-start"
            )}>
                <div className={cn(
                    "flex items-center gap-2 mb-2 text-primary/80 text-sm font-mono tracking-wider",
                    isEven ? "md:flex-row-reverse" : "md:flex-row"
                )}>
                    <span>{milestone.date}</span>
                    <Icon className="w-4 h-4" />
                </div>

                <motion.div
                    layout
                    onClick={() => setIsExpanded(!isExpanded)}
                    className={cn(
                        "relative cursor-pointer overflow-hidden rounded-xl border border-white/5 bg-white/5 backdrop-blur-md hover:bg-white/10 hover:border-primary/50 transition-colors duration-300 p-6 w-full shadow-lg",
                        isExpanded ? "ring-1 ring-primary/50 bg-white/10" : ""
                    )}
                    whileHover={{ scale: 1.02 }}
                    transition={{ type: "spring", stiffness: 300, damping: 20 }}
                >
                    <div className="absolute inset-0 bg-gradient-to-br from-primary/5 via-transparent to-secondary/5 opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none" />

                    <div className="flex flex-col gap-2 relative z-10 items-start text-left">


                        <p className="text-foreground/90 text-base font-medium leading-relaxed">
                            {milestone.description}
                        </p>

                        <AnimatePresence>
                            {isExpanded && (
                                <motion.div
                                    initial={{ opacity: 0, height: 0 }}
                                    animate={{ opacity: 1, height: "auto" }}
                                    exit={{ opacity: 0, height: 0 }}
                                    transition={{ duration: 0.3 }}
                                    className="mt-4 pt-4 border-t border-white/10 text-sm text-foreground/80 leading-relaxed"
                                >
                                    {milestone.longDescription}
                                </motion.div>
                            )}
                        </AnimatePresence>

                        <div className="mt-2 w-full flex justify-center opacity-50">
                            <motion.div
                                animate={{ rotate: isExpanded ? 180 : 0 }}
                                className="text-primary"
                            >
                                <ChevronDown className="w-4 h-4" />
                            </motion.div>
                        </div>
                    </div>
                </motion.div>
            </div>

        </motion.div>
    );
}
