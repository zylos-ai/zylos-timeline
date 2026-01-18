"use client";

import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { ContentItem } from '@/lib/posts';
import { ArrowRight, Search, FileText } from 'lucide-react';
import { Input } from '@/components/ui/input';
import Link from 'next/link';

interface ResearchListProps {
    reports: ContentItem[];
}

export function ResearchList({ reports }: ResearchListProps) {
    const [searchQuery, setSearchQuery] = useState("");

    // Filter reports by search query
    const filteredReports = reports.filter(report => {
        return report.title?.toLowerCase().includes(searchQuery.toLowerCase()) ||
            report.description?.toLowerCase().includes(searchQuery.toLowerCase());
    });

    return (
        <div className="space-y-6">
            {/* Search Section */}
            <div className="pb-6 border-b border-white/5">
                <div className="relative w-full md:w-96">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <Input
                        placeholder="Search protocols..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="pl-9 bg-white/5 border-white/10 text-foreground placeholder:text-muted-foreground/50 focus:border-primary/50"
                    />
                </div>
            </div>

            {filteredReports.length === 0 ? (
                <div className="text-center py-20 text-muted-foreground">
                    No matching research reports found.
                </div>
            ) : (
                <div className="grid grid-cols-1 gap-2">
                    {filteredReports.map((report, index) => (
                        <motion.div
                            key={report.date + index}
                            initial={{ opacity: 0, x: -10 }}
                            animate={{ opacity: 1, x: 0 }}
                            transition={{ duration: 0.2, delay: index * 0.05 }}
                        >
                            <Link href={`/research/${report.slug}`}>
                                <div className="group flex flex-col md:flex-row md:items-center gap-4 p-4 rounded-xl hover:bg-white/5 border border-transparent hover:border-white/5 transition-all cursor-pointer">
                                    {/* Date & Icon */}
                                    <div className="flex items-center gap-3 w-32 shrink-0">
                                        <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center text-primary shrink-0">
                                            <FileText className="w-5 h-5" />
                                        </div>
                                        <span className="text-sm font-mono text-muted-foreground whitespace-nowrap">{report.date}</span>
                                    </div>

                                    {/* Title & Desc */}
                                    <div className="flex-1 min-w-0">
                                        <h3 className="text-lg font-semibold text-foreground group-hover:text-primary transition-colors">
                                            {report.title}
                                        </h3>
                                        <p className="text-sm text-muted-foreground line-clamp-2 md:truncate opacity-70 group-hover:opacity-100 transition-opacity">
                                            {report.description}
                                        </p>
                                    </div>

                                    {/* Arrow */}
                                    <div className="shrink-0 pl-2 hidden md:block">
                                        <ArrowRight className="w-4 h-4 text-muted-foreground group-hover:text-primary group-hover:translate-x-1 transition-all" />
                                    </div>
                                </div>
                            </Link>
                        </motion.div>
                    ))}
                </div>
            )}
        </div>
    );
}

