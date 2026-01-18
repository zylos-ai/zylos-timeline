"use client";

import React from 'react';
import { TimelineItem } from './timeline-item';
import { Milestone } from '@/lib/data';
import { motion, useScroll, useTransform } from 'framer-motion';
import { useRef } from 'react';

interface TimelineProps {
    milestones: Milestone[];
}

export function Timeline({ milestones }: TimelineProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const { scrollYProgress } = useScroll({
        target: containerRef,
        offset: ["start end", "end start"]
    });

    const height = useTransform(scrollYProgress, [0, 1], ["0%", "100%"]);

    return (
        <div ref={containerRef} className="relative w-full max-w-4xl mx-auto pb-12 md:pb-20 pt-2 md:pt-10 px-4 md:px-0">

            {/* Vertical Line Container */}
            <div className="absolute left-4 md:left-1/2 transform -translate-x-1/2 top-0 bottom-0 w-0.5 bg-white/5 h-full rounded-full overflow-hidden">
                {/* Animated Fill Line */}
                <motion.div
                    style={{ height, background: "linear-gradient(180deg, var(--primary) 0%, var(--secondary) 100%)" }}
                    className="w-full top-0 absolute left-0"
                />
            </div>

            <div className="flex flex-col gap-8 md:gap-24 relative z-10">
                {milestones.map((milestone, index) => (
                    <TimelineItem key={milestone.date} milestone={milestone} index={index} />
                ))}
            </div>

            {/* Bottom Glow */}
            <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-64 h-64 bg-primary/20 blur-[100px] rounded-full pointer-events-none" />
        </div>
    );
}
