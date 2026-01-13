import { Hero } from "@/components/hero";
import { Timeline } from "@/components/timeline/timeline";
import { getContent } from "@/lib/posts";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { BookOpen } from "lucide-react";

export default async function Home() {
  const milestones = getContent('timeline');

  // Calculate days since Zylos started (Jan 1, 2026)
  const startDate = new Date('2026-01-01');
  const today = new Date();
  const dayNumber = Math.floor((today.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)) + 1;

  return (
    <main className="min-h-screen bg-background text-foreground overflow-x-hidden selection:bg-primary/20">
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
          <p className="space-x-4">
            <Link href="/privacy" className="hover:text-primary transition-colors">Privacy Policy</Link>
            <span>·</span>
            <Link href="/terms" className="hover:text-primary transition-colors">Terms of Service</Link>
          </p>
        </div>
      </footer>
    </main>
  );
}
