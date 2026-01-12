"use client";

import React, { useState, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ContentItem } from '@/lib/posts';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { CalendarIcon, ArrowRight, Search, FileText, Tag } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import ReactMarkdown from 'react-markdown';
import { cn } from '@/lib/utils';
import Link from 'next/link';

interface ResearchListProps {
    reports: ContentItem[];
}

export function ResearchList({ reports }: ResearchListProps) {
    const [searchQuery, setSearchQuery] = useState("");
    const [selectedTag, setSelectedTag] = useState<string | null>(null);

    // Extract all unique tags
    const allTags = useMemo(() => {
        const tags = new Set<string>();
        reports.forEach(r => r.tags?.forEach(t => tags.add(t)));
        return Array.from(tags).sort();
    }, [reports]);

    // Filter reports
    const filteredReports = reports.filter(report => {
        const matchesSearch =
            report.title?.toLowerCase().includes(searchQuery.toLowerCase()) ||
            report.description?.toLowerCase().includes(searchQuery.toLowerCase()) ||
            report.tags?.some(tag => tag.toLowerCase().includes(searchQuery.toLowerCase()));

        const matchesTag = selectedTag ? report.tags?.includes(selectedTag) : true;

        return matchesSearch && matchesTag;
    });

    return (
        <div className="space-y-6">
            {/* Search and Filter Section */}
            <div className="flex flex-col md:flex-row gap-4 items-start md:items-center justify-between pb-6 border-b border-white/5">
                <div className="relative w-full md:w-96">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <Input
                        placeholder="Search protocols..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="pl-9 bg-white/5 border-white/10 text-foreground placeholder:text-muted-foreground/50 focus:border-primary/50"
                    />
                </div>

                <div className="flex flex-wrap gap-2">
                    <Badge
                        variant={selectedTag === null ? "default" : "outline"}
                        className={cn(
                            "cursor-pointer transition-colors",
                            selectedTag === null ? "bg-primary text-primary-foreground hover:bg-primary/90" : "hover:bg-primary/10 hover:text-primary border-white/10"
                        )}
                        onClick={() => setSelectedTag(null)}
                    >
                        All Types
                    </Badge>
                    {allTags.map(tag => (
                        <Badge
                            key={tag}
                            variant={selectedTag === tag ? "default" : "outline"}
                            className={cn(
                                "cursor-pointer transition-colors",
                                selectedTag === tag ? "bg-primary text-primary-foreground hover:bg-primary/90" : "hover:bg-primary/10 hover:text-primary border-white/10"
                            )}
                            onClick={() => setSelectedTag(selectedTag === tag ? null : tag)}
                        >
                            {tag}
                        </Badge>
                    ))}
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
                                        <h3 className="text-lg font-semibold text-foreground group-hover:text-primary transition-colors truncate">
                                            {report.title}
                                        </h3>
                                        <p className="text-sm text-muted-foreground truncate opacity-70 group-hover:opacity-100 transition-opacity">
                                            {report.description}
                                        </p>
                                    </div>

                                    {/* Tags */}
                                    <div className="flex items-center gap-2 shrink-0">
                                        {report.tags?.map((tag) => (
                                            <span key={tag} className="text-xs px-2 py-1 rounded-full bg-white/5 text-muted-foreground border border-white/5 whitespace-nowrap">
                                                {tag}
                                            </span>
                                        ))}
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

