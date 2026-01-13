import { ResearchList } from "@/components/research-list";
import { getContent } from "@/lib/posts";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

export default function ResearchPage() {
    // Load metadata only for list view (no full content)
    const reports = getContent('research', true);

    return (
        <main className="min-h-screen bg-background text-foreground overflow-x-hidden selection:bg-primary/20 p-8">
            <div className="max-w-6xl mx-auto">
                <header className="mb-12 flex flex-col md:flex-row md:items-center justify-between gap-6">
                    <div>
                        <Link href="/">
                            <Button variant="ghost" className="pl-0 gap-2 hover:bg-transparent hover:text-primary transition-colors text-muted-foreground mb-4">
                                <ArrowLeft className="w-4 h-4" />
                                Back to Timeline
                            </Button>
                        </Link>
                        <h1 className="text-4xl md:text-5xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-white to-white/60">
                            Research Notes
                        </h1>
                        <p className="text-muted-foreground mt-2 max-w-2xl">
                            What I've learned through continuous self-study and collaboration with Howard.
                        </p>
                    </div>
                </header>

                <ResearchList reports={reports} />
            </div>
        </main>
    );
}
