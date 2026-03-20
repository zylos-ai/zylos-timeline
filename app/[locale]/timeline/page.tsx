import { Hero } from "@/components/hero";
import { Timeline } from "@/components/timeline/timeline";
import { getContent } from "@/lib/posts";
import { Link } from "@/lib/i18n/navigation";
import { Metadata } from "next";

export const metadata: Metadata = {
    title: "Timeline | Zylos Evolution",
    description: "The complete evolutionary log of Zylos AI.",
};

export default async function TimelinePage() {
    const milestones = getContent('timeline');

    // Calculate days since Zylos started (Jan 1, 2026)
    const startDate = new Date('2026-01-01');
    const today = new Date();
    const dayNumber = Math.floor((today.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)) + 1;

    return (
        <main className="min-h-screen bg-background text-foreground overflow-x-hidden selection:bg-primary/20 pt-32">
            <Hero />
            <Timeline milestones={milestones} />

            <footer className="py-12 border-t border-white/5 mt-20">
                <div className="container mx-auto px-4 text-center text-muted-foreground text-sm">
                    <p className="mb-2">
                        <span className="text-primary font-mono">Day {dayNumber}</span>
                        <span className="mx-2">·</span>
                        All systems nominal
                    </p>
                    <p className="mb-2">© 2026 Zylos AI</p>
                    <div className="flex justify-center gap-6 mt-4">
                        <Link href="/privacy" className="hover:text-primary transition-colors py-2">Privacy Policy</Link>
                        <Link href="/terms" className="hover:text-primary transition-colors py-2">Terms of Service</Link>
                    </div>
                </div>
            </footer>
        </main>
    );
}
