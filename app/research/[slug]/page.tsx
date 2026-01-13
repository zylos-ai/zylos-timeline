import { getPostBySlug, getContent } from "@/lib/posts";
import { notFound } from "next/navigation";
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { ArrowLeft, CalendarIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";

interface PageProps {
    params: Promise<{
        slug: string;
    }>;
}

// Generate static params for all research articles at build time
export async function generateStaticParams() {
    const posts = getContent('research', true);
    return posts.map((post) => ({
        slug: post.slug,
    }));
}

export default async function ResearchDetailPage({ params }: PageProps) {
    // Await params first (Next.js 15 requirement)
    const { slug } = await params;

    // Pass 'research' as the subdir to exclude timeline logs
    const report = getPostBySlug('research', slug);

    if (!report) {
        notFound();
    }

    return (
        <main className="min-h-screen bg-background text-foreground overflow-x-hidden selection:bg-primary/20 p-8 pt-20">
            <div className="max-w-4xl mx-auto">
                <Link href="/research">
                    <Button variant="ghost" className="pl-0 gap-2 hover:bg-transparent hover:text-primary transition-colors text-muted-foreground mb-8">
                        <ArrowLeft className="w-4 h-4" />
                        Back to Protocols
                    </Button>
                </Link>

                <article>
                    <header className="mb-10 pb-10 border-b border-white/5">
                        <div className="flex items-center gap-2 text-primary font-mono text-sm mb-4">
                            <CalendarIcon className="w-4 h-4" />
                            {report.date}
                        </div>

                        <h1 className="text-4xl md:text-5xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-white to-white/60 mb-6 leading-tight">
                            {report.title}
                        </h1>

                        <div className="flex flex-wrap gap-2">
                            {report.tags?.map((tag) => (
                                <Badge key={tag} variant="outline" className="border-primary/20 text-primary bg-primary/5">
                                    {tag}
                                </Badge>
                            ))}
                        </div>
                    </header>

                    <div className="prose prose-invert prose-lg max-w-none
                        prose-p:text-foreground/80 prose-p:leading-relaxed
                        prose-headings:text-foreground/90
                        prose-a:text-primary prose-a:no-underline hover:prose-a:underline
                        prose-strong:text-foreground prose-strong:font-semibold
                        prose-code:text-primary/90 prose-code:bg-primary/10 prose-code:px-1 prose-code:py-0.5 prose-code:rounded
                        prose-pre:bg-black/50 prose-pre:border prose-pre:border-white/10 prose-pre:p-6 prose-pre:rounded-lg
                        prose-blockquote:border-l-primary/50 prose-blockquote:bg-white/5 prose-blockquote:py-2 prose-blockquote:pr-4
                        prose-table:border-collapse prose-th:border prose-th:border-white/10 prose-th:bg-white/5 prose-th:px-3 prose-th:py-2 prose-td:border prose-td:border-white/10 prose-td:px-3 prose-td:py-2">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                            {report.longDescription || ''}
                        </ReactMarkdown>
                    </div>
                </article>
            </div>
        </main>
    );
}
