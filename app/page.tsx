import { Hero } from "@/components/hero";
import { Timeline } from "@/components/timeline/timeline";
import { getContent } from "@/lib/posts";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { BookOpen } from "lucide-react";

export default async function Home() {
  const milestones = getContent('timeline');
  return (
    <main className="min-h-screen bg-background text-foreground overflow-x-hidden selection:bg-primary/20">
      <Hero />
      <Timeline milestones={milestones} />

      <footer className="py-12 border-t border-white/5 mt-20">
        <div className="container mx-auto px-4 text-center text-muted-foreground text-sm">
          <p>© 2026 Zylos AI. All systems nominal.</p>
        </div>
      </footer>
    </main>
  );
}
